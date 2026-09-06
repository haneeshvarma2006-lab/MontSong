import { requireAdmin } from '@/lib/auth/guard';
import { ADMIN_WRITE_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { errorResponse, json } from '@/lib/http/respond';
import { logger } from '@/lib/logger';
import * as cache from '@/lib/media/cache';
import { deleteAudio, getAudio, moveAudio, setPublished, updateAudio } from '@/lib/repositories/audio';
import { toAdminAudio } from '@/lib/serializers';
import { deleteStoredMedia } from '@/lib/telegram/storage';
import { parseJsonBody } from '@/lib/validation/parse';
import { moveAudioSchema, updateAudioSchema } from '@/lib/validation/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/admin/audio/:id */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request);
    const { id } = await context.params;
    const audio = await getAudio(id);
    if (!audio) throw notFound('That track no longer exists.');
    return json({ audio: toAdminAudio(audio) });
  } catch (error) {
    return errorResponse(error, { route: 'admin.audio.get', audience: 'admin' });
  }
}

/**
 * PATCH /api/admin/audio/:id
 *
 * Also handles the two single-purpose actions the songs table needs, chosen by
 * `?action=`, so the table does not need three separate endpoints for what are
 * all partial updates of one row.
 *   ?action=publish&value=true|false
 *   ?action=move    (body: { categoryId })
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: ADMIN_WRITE_RULE, bucket: 'audio' });

    const { id } = await context.params;
    const action = new URL(request.url).searchParams.get('action');

    if (action === 'publish') {
      const value = new URL(request.url).searchParams.get('value') !== 'false';
      const audio = await setPublished(id, value);
      return json({ audio: toAdminAudio(audio) });
    }

    if (action === 'move') {
      const { categoryId } = await parseJsonBody(request, moveAudioSchema);
      const audio = await moveAudio(id, categoryId);
      return json({ audio: toAdminAudio(audio) });
    }

    const input = await parseJsonBody(request, updateAudioSchema);
    const audio = await updateAudio(id, input);
    return json({ audio: toAdminAudio(audio) });
  } catch (error) {
    return errorResponse(error, { route: 'admin.audio.update', audience: 'admin' });
  }
}

/**
 * DELETE /api/admin/audio/:id
 *
 * The database row goes first, inside a transaction. Removing the Telegram
 * message and the cached file happens afterwards and is best effort: a Telegram
 * outage must not leave a track the owner asked to delete still visible on the
 * site, and an undeletable message is reported rather than retried forever.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: ADMIN_WRITE_RULE, bucket: 'audio' });

    const { id } = await context.params;
    const { orphanedMedia } = await deleteAudio(id);

    const storageWarnings: string[] = [];
    for (const media of orphanedMedia) {
      await cache.purge(media.telegramFileUniqueId).catch(() => undefined);
      const removed = await deleteStoredMedia(media);
      if (!removed) {
        storageWarnings.push(
          `The stored copy of "${media.fileName}" could not be removed automatically.`,
        );
        logger.warn('audio.delete_storage_residue', { fileName: media.fileName });
      }
    }

    return json({ ok: true, storageWarnings });
  } catch (error) {
    return errorResponse(error, { route: 'admin.audio.delete', audience: 'admin' });
  }
}
