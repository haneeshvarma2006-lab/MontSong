import 'server-only';

import {
  ALLOWED_AUDIO_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
  type MediaKind,
} from '../constants';
import { prisma } from '../db';
import { getConfig } from '../env';
import { badRequest, conflict, payloadTooLarge, unsupportedMediaType } from '../errors';
import { createId } from '../ids';
import { logger } from '../logger';
import { getTelegramClient } from '../telegram/client';
import { formatBytes } from '../format';
import type { SpooledFile } from './spool';

import type { MediaFile, UploadIntent } from '@/generated/prisma';

/**
 * The upload pipeline, and the reconciliation guarantee that goes with it.
 *
 * ## The failure that matters
 *
 * Storing a file spans two systems. Telegram accepts the bytes, then the
 * database records where they went. If the process dies between those steps,
 * the naive implementation has permanently lost a file: the bytes exist in a
 * private channel with no record of what they are, and nothing will ever
 * mention them again.
 *
 * So a durable `UploadIntent` row is written *before* the bytes leave this
 * machine, and updated with Telegram's identifiers the instant they come back.
 * The states it moves through:
 *
 *   received  -> a validated file is spooled, nothing sent yet
 *   uploading -> handed to Telegram, outcome unknown
 *   uploaded  -> Telegram returned identifiers; they are now durable
 *   committed -> a MediaFile and Audio row exist; the intent is history
 *   failed    -> Telegram refused; nothing was stored, nothing leaked
 *
 * Every row that stops at `uploading` or `uploaded` is an orphan, and the admin
 * Storage screen lists them with two actions: adopt (turn it into a track
 * without re-uploading) or discard (delete the Telegram message and the row).
 * Nothing is ever silently lost.
 */

export interface ValidatedUpload {
  readonly file: SpooledFile;
  readonly mimeType: string;
  readonly kind: MediaKind;
}

/**
 * Validate a spooled file against what this site will store and play.
 *
 * The declared Content-Type is never trusted on its own: the file must be
 * identifiable from its own bytes, that identity must be an accepted format,
 * and if the client declared a type it has to agree. A .mp3 that is actually a
 * shell script fails at the first test; a real MP3 renamed to .txt passes,
 * because the bytes are what matter.
 */
export function validateUpload(file: SpooledFile, expected: MediaKind): ValidatedUpload {
  const config = getConfig();
  const limit = expected === 'audio' ? config.uploads.maxAudioBytes : config.uploads.maxImageBytes;

  if (file.bytes === 0) {
    throw badRequest('That file is empty.');
  }
  if (file.bytes > limit) {
    throw payloadTooLarge(`That file is larger than the ${formatBytes(limit)} limit for this site.`);
  }

  if (!file.detectedMimeType || file.kind === null) {
    throw unsupportedMediaType(
      'That file could not be recognised as audio. Supported formats: MP3, M4A, AAC, OGG, Opus, WAV and FLAC.',
    );
  }

  if (file.kind !== expected) {
    throw unsupportedMediaType(
      expected === 'audio'
        ? `That looks like ${file.detectedFormat ?? 'an image'}, not an audio file.`
        : `That looks like ${file.detectedFormat ?? 'audio'}, not an image.`,
    );
  }

  const allowed: readonly string[] =
    expected === 'audio' ? ALLOWED_AUDIO_MIME_TYPES : ALLOWED_IMAGE_MIME_TYPES;

  if (!allowed.includes(file.detectedMimeType)) {
    throw unsupportedMediaType(
      `${file.detectedFormat ?? file.detectedMimeType} files are not supported here. ` +
        (expected === 'audio'
          ? 'Use MP3, M4A, AAC, OGG, Opus, WAV or FLAC.'
          : 'Use JPEG, PNG or WebP.'),
    );
  }

  // A declared type that contradicts the bytes is a spoofing attempt or a
  // broken client; either way, refuse rather than guess which one is right.
  if (
    file.declaredMimeType &&
    file.declaredMimeType !== 'application/octet-stream' &&
    file.declaredMimeType !== file.detectedMimeType
  ) {
    logger.warn('upload.mime_mismatch', {
      declared: file.declaredMimeType,
      detected: file.detectedMimeType,
      fileName: file.fileName,
    });
    throw unsupportedMediaType(
      `That file says it is ${file.declaredMimeType} but its contents are ${file.detectedFormat}. ` +
        'Re-export it and try again.',
    );
  }

  return { file, mimeType: file.detectedMimeType, kind: expected };
}

/** Refuse a byte-identical re-upload rather than storing it twice. */
export async function findDuplicate(sha256: string): Promise<MediaFile | null> {
  return prisma.mediaFile.findFirst({ where: { sha256 } });
}

export async function createIntent(upload: ValidatedUpload, payload: unknown): Promise<UploadIntent> {
  return prisma.uploadIntent.create({
    data: {
      id: createId(),
      originalFileName: upload.file.fileName,
      mimeType: upload.mimeType,
      fileSize: upload.file.bytes,
      sha256: upload.file.sha256,
      status: 'received',
      payload: payload === undefined ? null : JSON.stringify(payload),
    },
  });
}

export interface StoreResult {
  readonly media: MediaFile;
  readonly intent: UploadIntent;
}

/**
 * Send the bytes to Telegram and record the result.
 *
 * The `uploaded` update is a single tiny write against a row that already
 * exists, which is as close to atomic-with-the-upload as two systems allow. If
 * *that* write fails the intent is still sitting at `uploading`, and the error
 * message tells the admin exactly where to look.
 */
export async function storeMedia(
  upload: ValidatedUpload,
  intent: UploadIntent,
  options: { caption?: string; durationSec?: number; title?: string; performer?: string } = {},
): Promise<StoreResult> {
  const client = getTelegramClient();

  await prisma.uploadIntent.update({
    where: { id: intent.id },
    data: { status: 'uploading' },
  });

  let sent;
  try {
    sent =
      upload.kind === 'audio'
        ? await client.uploadAudio({
            filePath: upload.file.path,
            fileName: upload.file.fileName,
            mimeType: upload.mimeType,
            caption: options.caption,
            durationSec: options.durationSec,
            title: options.title,
            performer: options.performer,
          })
        : await client.uploadImage({
            filePath: upload.file.path,
            fileName: upload.file.fileName,
            mimeType: upload.mimeType,
            caption: options.caption,
          });
  } catch (error) {
    await prisma.uploadIntent
      .update({
        where: { id: intent.id },
        data: { status: 'failed', error: String(error).slice(0, 500) },
      })
      .catch(() => undefined);
    throw error;
  }

  // Durability point. Everything after this can fail without losing the file.
  const updatedIntent = await prisma.uploadIntent.update({
    where: { id: intent.id },
    data: {
      status: 'uploaded',
      telegramChatId: sent.chatId,
      telegramMessageId: sent.messageId,
      telegramFileId: sent.file.fileId,
      telegramFileUniqueId: sent.file.fileUniqueId,
    },
  });

  const media = await prisma.mediaFile.create({
    data: {
      id: createId(),
      kind: upload.kind,
      telegramChatId: sent.chatId,
      telegramMessageId: sent.messageId,
      telegramFileId: sent.file.fileId,
      telegramFileUniqueId: sent.file.fileUniqueId,
      mimeType: upload.mimeType,
      fileName: upload.file.fileName,
      // Trust our own byte count over Telegram's echo of it.
      fileSize: upload.file.bytes,
      durationSec: options.durationSec ?? sent.file.durationSec ?? null,
      width: sent.file.width ?? null,
      height: sent.file.height ?? null,
      sha256: upload.file.sha256,
      status: 'stored',
    },
  });

  return { media, intent: updatedIntent };
}

export async function markIntentCommitted(intentId: string, audioId: string): Promise<void> {
  await prisma.uploadIntent
    .update({ where: { id: intentId }, data: { status: 'committed', audioId } })
    .catch((error: unknown) =>
      logger.warn('upload.intent_commit_failed', { intentId, reason: String(error) }),
    );
}

// --- Reconciliation ---------------------------------------------------------

export interface OrphanedUpload {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly status: string;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly hasTelegramFile: boolean;
  readonly payload: Record<string, unknown> | null;
}

/**
 * Uploads that reached Telegram but never became a track.
 *
 * `uploading` rows older than the grace period are included too: an upload
 * still in flight is not an orphan, but one that has been "in flight" for ten
 * minutes is a crashed request whose outcome is genuinely unknown, and the
 * admin needs to see it.
 */
export async function listOrphanedUploads(graceMinutes = 10): Promise<OrphanedUpload[]> {
  const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000);

  const rows = await prisma.uploadIntent.findMany({
    where: {
      OR: [
        { status: 'uploaded' },
        { status: 'uploading', updatedAt: { lt: cutoff } },
        { status: 'failed', createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return rows.map((row) => ({
    id: row.id,
    fileName: row.originalFileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    hasTelegramFile: row.telegramFileId !== null,
    payload: parsePayload(row.payload),
  }));
}

/**
 * Turn an orphaned intent into a real MediaFile row without re-uploading —
 * the bytes are already in Telegram, only the bookkeeping is missing.
 */
export async function adoptOrphan(intentId: string): Promise<MediaFile> {
  const intent = await prisma.uploadIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw badRequest('That upload record no longer exists.');
  if (!intent.telegramFileId || !intent.telegramFileUniqueId || !intent.telegramChatId) {
    throw conflict('That upload never reached storage, so there is nothing to recover.');
  }

  const existing = await prisma.mediaFile.findUnique({
    where: { telegramFileUniqueId: intent.telegramFileUniqueId },
  });
  if (existing) {
    await prisma.uploadIntent.update({ where: { id: intentId }, data: { status: 'committed' } });
    return existing;
  }

  const media = await prisma.mediaFile.create({
    data: {
      id: createId(),
      kind: intent.mimeType.startsWith('image/') ? 'image' : 'audio',
      telegramChatId: intent.telegramChatId,
      telegramMessageId: intent.telegramMessageId,
      telegramFileId: intent.telegramFileId,
      telegramFileUniqueId: intent.telegramFileUniqueId,
      mimeType: intent.mimeType,
      fileName: intent.originalFileName,
      fileSize: intent.fileSize,
      sha256: intent.sha256,
      status: 'stored',
    },
  });

  // Close the intent out. Without this the recovered upload would keep showing
  // up as an orphan, and adopting it again would create a second media row for
  // the same stored file.
  await prisma.uploadIntent.update({
    where: { id: intentId },
    data: { status: 'committed' },
  });

  return media;
}

/**
 * Discard an orphan: remove the Telegram message if we can, then the row.
 * A message Telegram refuses to delete leaves the row marked `abandoned` so it
 * stops appearing as actionable while staying auditable.
 */
export async function discardOrphan(intentId: string): Promise<{ telegramDeleted: boolean }> {
  const intent = await prisma.uploadIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw badRequest('That upload record no longer exists.');

  let telegramDeleted = false;
  if (intent.telegramMessageId !== null) {
    telegramDeleted = await getTelegramClient().deleteMessage(intent.telegramMessageId);
  }

  if (telegramDeleted || intent.telegramMessageId === null) {
    await prisma.uploadIntent.delete({ where: { id: intentId } });
  } else {
    await prisma.uploadIntent.update({
      where: { id: intentId },
      data: { status: 'abandoned', error: 'Telegram refused to delete the message.' },
    });
  }

  return { telegramDeleted };
}

/** Remove committed intents that are older than a week; they are pure history. */
export async function pruneCommittedIntents(days = 7): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { count } = await prisma.uploadIntent.deleteMany({
    where: { status: 'committed', updatedAt: { lt: cutoff } },
  });
  return count;
}

function parsePayload(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
