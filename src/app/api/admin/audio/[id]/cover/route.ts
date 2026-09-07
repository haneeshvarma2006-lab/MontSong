import { requireAdmin } from '@/lib/auth/guard';
import { UPLOAD_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas, prisma } from '@/lib/db';
import { getConfig } from '@/lib/env';
import { conflict, notFound } from '@/lib/errors';
import { errorResponse, json } from '@/lib/http/respond';
import * as cache from '@/lib/media/cache';
import { getAudio } from '@/lib/repositories/audio';
import { toAdminAudio } from '@/lib/serializers';
import { deleteStoredMedia } from '@/lib/telegram/storage';
import { storeImage, validateUpload } from '@/lib/upload/service';
import { assertSpoolIntact, fileByField, spoolMultipart } from '@/lib/upload/spool';

/**
 * Cover art for an existing track.
 *
 * POST replaces it, DELETE removes it. Both clean up the media row they orphan,
 * so artwork churn does not accumulate unreferenced files in Telegram.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let spool: Awaited<ReturnType<typeof spoolMultipart>> | null = null;

  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: UPLOAD_RULE, bucket: 'upload' });

    const { id } = await context.params;
    const audio = await getAudio(id);
    if (!audio) throw notFound('That track no longer exists.');

    spool = await spoolMultipart(request, {
      maxFileBytes: getConfig().uploads.maxImageBytes,
      maxFiles: 1,
    });

    const part = fileByField(spool, 'cover') ?? spool.files[0];
    if (!part) throw conflict('No image was included in that upload.');
    await assertSpoolIntact(part);

    const upload = validateUpload(part, 'image');
    // Reuses an already-stored image rather than colliding on it; see storeImage.
    const mediaId = await storeImage(upload, audio.title);

    const previousCover = audio.cover;
    await prisma.audio.update({ where: { id }, data: { coverMediaId: mediaId } });

    if (previousCover) await retireMedia(previousCover.id);

    const updated = await getAudio(id);
    return json({ audio: updated ? toAdminAudio(updated) : null });
  } catch (error) {
    return errorResponse(error, { route: 'admin.audio.cover.set', audience: 'admin' });
  } finally {
    await spool?.cleanup();
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: UPLOAD_RULE, bucket: 'upload' });

    const { id } = await context.params;
    const audio = await getAudio(id);
    if (!audio) throw notFound('That track no longer exists.');
    if (!audio.cover) return json({ ok: true });

    await prisma.audio.update({ where: { id }, data: { coverMediaId: null } });
    await retireMedia(audio.cover.id);

    const updated = await getAudio(id);
    return json({ audio: updated ? toAdminAudio(updated) : null });
  } catch (error) {
    return errorResponse(error, { route: 'admin.audio.cover.delete', audience: 'admin' });
  }
}

/**
 * Drop a media row once nothing references it, removing the cached copy and
 * the Telegram message with it. A cover shared by another track or a category
 * is left alone.
 */
async function retireMedia(mediaId: string): Promise<void> {
  const [audioUsers, categoryUsers] = await Promise.all([
    prisma.audio.count({ where: { OR: [{ mediaId }, { coverMediaId: mediaId }] } }),
    prisma.category.count({ where: { coverMediaId: mediaId } }),
  ]);
  if (audioUsers > 0 || categoryUsers > 0) return;

  const media = await prisma.mediaFile.findUnique({ where: { id: mediaId } });
  if (!media) return;

  await cache.purge(media.telegramFileUniqueId).catch(() => undefined);
  await deleteStoredMedia(media);
  await prisma.mediaFile.delete({ where: { id: mediaId } }).catch(() => undefined);
}
