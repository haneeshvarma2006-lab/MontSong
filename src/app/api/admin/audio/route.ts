import { requireAdmin } from '@/lib/auth/guard';
import { UPLOAD_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas } from '@/lib/db';
import { conflict } from '@/lib/errors';
import { errorResponse, json } from '@/lib/http/respond';
import { logger } from '@/lib/logger';
import { createAudio, listAudioForAdmin } from '@/lib/repositories/audio';
import { toAdminAudio } from '@/lib/serializers';
import {
  createIntent,
  findDuplicate,
  markIntentCommitted,
  storeMedia,
  validateUpload,
} from '@/lib/upload/service';
import { assertSpoolIntact, fileByField, spoolMultipart } from '@/lib/upload/spool';
import { getConfig } from '@/lib/env';
import { parseOrThrow, parseSearchParams } from '@/lib/validation/parse';
import { adminAudioQuerySchema, audioMetadataSchema } from '@/lib/validation/schemas';

/**
 * Admin track collection.
 *
 * The Node runtime and `force-dynamic` are load-bearing: the POST handler reads
 * the raw request body as a stream and writes it to disk as it arrives, which
 * requires a real Node request and rules out any static optimisation.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Uploads are streamed to disk; a slow connection must not be cut off. */
export const maxDuration = 600;

/** GET /api/admin/audio — paginated, searchable, filterable listing. */
export async function GET(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request);

    const url = new URL(request.url);
    const query = parseSearchParams(url.searchParams, adminAudioQuerySchema);
    const page = await listAudioForAdmin(query);

    return json({
      items: page.items.map(toAdminAudio),
      total: page.total,
      page: page.page,
      perPage: page.perPage,
      pageCount: page.pageCount,
    });
  } catch (error) {
    return errorResponse(error, { route: 'admin.audio.list', audience: 'admin' });
  }
}

/**
 * POST /api/admin/audio — upload a track.
 *
 * Ordering here is the whole design. Validation happens against the *bytes*
 * before anything is sent anywhere; a durable `UploadIntent` is written before
 * the bytes leave this machine; the intent records Telegram's identifiers the
 * instant they come back. If the process dies at any point after that, the file
 * is recoverable from the admin Storage screen rather than lost.
 *
 * Body: multipart/form-data
 *   audio    (file, required)
 *   cover    (file, optional)
 *   metadata (field, JSON) — title, artist, type, categoryId, tags, ...
 */
export async function POST(request: Request): Promise<Response> {
  const config = getConfig();
  let spool: Awaited<ReturnType<typeof spoolMultipart>> | null = null;

  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: UPLOAD_RULE, bucket: 'upload' });

    spool = await spoolMultipart(request, {
      // Spool against the larger of the two ceilings; each part is then held to
      // its own limit by validateUpload, which knows which kind it is.
      maxFileBytes: Math.max(config.uploads.maxAudioBytes, config.uploads.maxImageBytes),
      maxFiles: 2,
    });

    const audioPart = fileByField(spool, 'audio');
    if (!audioPart) {
      throw conflict('No audio file was included in that upload.');
    }
    await assertSpoolIntact(audioPart);

    const audioUpload = validateUpload(audioPart, 'audio');

    // Refuse a byte-identical re-upload rather than storing a second copy in
    // Telegram that nothing will ever distinguish from the first.
    const duplicate = await findDuplicate(audioPart.sha256);
    if (duplicate) {
      throw conflict('That exact file has already been uploaded.');
    }

    const metadata = parseOrThrow(audioMetadataSchema, readMetadata(spool.fields));

    // --- Audio ---------------------------------------------------------------
    const intent = await createIntent(audioUpload, metadata);
    const { media } = await storeMedia(audioUpload, intent, {
      caption: `${metadata.title}${metadata.artist ? ` — ${metadata.artist}` : ''}`.slice(0, 1024),
      durationSec: metadata.durationSec,
      title: metadata.title,
      performer: metadata.artist,
    });

    // --- Optional cover ------------------------------------------------------
    let coverMediaId: string | null = null;
    const coverPart = fileByField(spool, 'cover');
    if (coverPart) {
      try {
        await assertSpoolIntact(coverPart);
        const coverUpload = validateUpload(coverPart, 'image');
        const coverIntent = await createIntent(coverUpload, { for: metadata.title });
        const stored = await storeMedia(coverUpload, coverIntent, { caption: metadata.title });
        coverMediaId = stored.media.id;
        await markIntentCommitted(coverIntent.id, stored.media.id);
      } catch (error) {
        // Artwork is optional. Losing it must not lose the track that has
        // already been stored, so record the failure and carry on.
        logger.warn('upload.cover_failed', { reason: String(error) });
      }
    }

    // --- Commit --------------------------------------------------------------
    const audio = await createAudio({
      title: metadata.title,
      slug: metadata.slug,
      artist: metadata.artist,
      type: metadata.type,
      description: metadata.description,
      categoryId: metadata.categoryId ?? null,
      tags: metadata.tags,
      isPublished: metadata.isPublished,
      isFeatured: metadata.isFeatured,
      mediaId: media.id,
      coverMediaId,
    });

    await markIntentCommitted(intent.id, audio.id);
    logger.info('upload.committed', { audioId: audio.id, bytes: audioPart.bytes });

    return json({ audio: toAdminAudio(audio) }, { status: 201 });
  } catch (error) {
    return errorResponse(error, { route: 'admin.audio.create', audience: 'admin' });
  } finally {
    await spool?.cleanup();
  }
}

/**
 * Metadata arrives either as a single JSON `metadata` field (what the admin UI
 * sends) or as individual form fields (what a curl-driven script sends). Accept
 * both; zod validates the result either way.
 */
function readMetadata(fields: Record<string, string>): unknown {
  if (fields.metadata) {
    try {
      return JSON.parse(fields.metadata);
    } catch {
      // Fall through to field-by-field parsing rather than failing outright.
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'metadata') continue;
    if (key === 'tags') {
      out.tags = value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
      continue;
    }
    if (key === 'isPublished' || key === 'isFeatured') {
      out[key] = value === 'true' || value === '1';
      continue;
    }
    out[key] = value;
  }
  return out;
}
