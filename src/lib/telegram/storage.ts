import 'server-only';

import { prisma } from '../db';
import { TELEGRAM_FILE_PATH_TTL_MS } from '../constants';
import { logger } from '../logger';
import { getTelegramClient, type DownloadHandle } from './client';

import type { MediaFile } from '@/generated/prisma';

/**
 * Storage service: the only module that knows both Telegram and the database.
 *
 * Everything above this layer deals in `MediaFile` rows and byte streams and
 * has no idea Telegram exists — which is what keeps Telegram invisible to the
 * public site.
 */

/**
 * Resolve a stored file to something readable, caching the resolution.
 *
 * Telegram guarantees a getFile path stays valid "for at least 1 hour". We
 * persist it and refresh at 45 minutes, so a busy track costs one getFile call
 * per 45 minutes instead of one per request — which matters because getFile
 * shares the bot's overall rate budget with uploads.
 */
export async function resolveFilePath(media: MediaFile): Promise<string> {
  const fresh =
    media.telegramFilePath &&
    media.telegramFilePathFetchedAt &&
    Date.now() - media.telegramFilePathFetchedAt.getTime() < TELEGRAM_FILE_PATH_TTL_MS;

  if (fresh && media.telegramFilePath) return media.telegramFilePath;

  const client = getTelegramClient();
  const { filePath } = await client.getFilePath(media.telegramFileId);

  await prisma.mediaFile
    .update({
      where: { id: media.id },
      data: { telegramFilePath: filePath, telegramFilePathFetchedAt: new Date() },
    })
    .catch((error: unknown) => {
      // A failed cache write must not fail the read path.
      logger.warn('storage.file_path_cache_failed', { mediaId: media.id, reason: String(error) });
    });

  return filePath;
}

/**
 * Open a byte stream for a stored file, transparently refreshing an expired
 * getFile path.
 *
 * Telegram answers an expired path with 404/410, which `openFile` turns into a
 * `storage_unavailable` AppError; rather than surfacing that, we invalidate our
 * cached path and try once more with a freshly resolved one.
 */
export async function openMedia(
  media: MediaFile,
  options: { range?: { start: number; end: number }; signal?: AbortSignal } = {},
): Promise<DownloadHandle> {
  const client = getTelegramClient();
  const filePath = await resolveFilePath(media);

  try {
    return await client.openFile(filePath, options);
  } catch (error) {
    logger.warn('storage.open_retry', { mediaId: media.id, reason: String(error) });

    await prisma.mediaFile
      .update({
        where: { id: media.id },
        data: { telegramFilePath: null, telegramFilePathFetchedAt: null },
      })
      .catch(() => undefined);

    const refreshed = await client.getFilePath(media.telegramFileId);
    await prisma.mediaFile
      .update({
        where: { id: media.id },
        data: {
          telegramFilePath: refreshed.filePath,
          telegramFilePathFetchedAt: new Date(),
        },
      })
      .catch(() => undefined);

    return client.openFile(refreshed.filePath, options);
  }
}

/**
 * Delete the Telegram message backing a media row, best effort.
 *
 * A message that cannot be removed (Telegram restricts what a bot may delete)
 * leaves the row marked `deleted` rather than silently vanishing, so the admin
 * storage screen can still account for it.
 */
export async function deleteStoredMedia(media: MediaFile): Promise<boolean> {
  const client = getTelegramClient();
  let removed = false;

  if (media.telegramMessageId !== null) {
    removed = await client.deleteMessage(media.telegramMessageId);
  }

  return removed;
}
