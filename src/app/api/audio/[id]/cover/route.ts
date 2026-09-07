import { limitPublic } from '@/lib/auth/guard';
import { MEDIA_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas, prisma } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { serveMedia } from '@/lib/media/serve';
import { errorResponse } from '@/lib/http/respond';

/**
 * GET /api/audio/:id/cover — artwork, served from this origin like everything
 * else. Cached hard: cover art for a given track never changes without the
 * track's media row changing, and the ETag covers that.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensurePragmas();
    limitPublic(request, MEDIA_RULE, 'cover');

    const { id } = await context.params;
    const audio = await prisma.audio.findUnique({
      where: { id },
      select: { isPublished: true, cover: true },
    });

    if (!audio?.isPublished || !audio.cover) throw notFound('No artwork for that track.');

    return await serveMedia({
      media: audio.cover,
      request,
      disposition: 'inline',
      cacheControl: 'public, max-age=604800, immutable',
    });
  } catch (error) {
    return errorResponse(error, { route: 'audio.cover', audience: 'public' });
  }
}

export const GET = handle;
export const HEAD = handle;
