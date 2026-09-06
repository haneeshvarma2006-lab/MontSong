import { limitPublic } from '@/lib/auth/guard';
import { MEDIA_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas, prisma } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { serveMedia } from '@/lib/media/serve';
import { errorResponse } from '@/lib/http/respond';

/** GET /api/categories/:id/cover — category artwork. */
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
    const category = await prisma.category.findUnique({
      where: { id },
      select: { isPublished: true, cover: true },
    });

    if (!category?.isPublished || !category.cover) throw notFound('No artwork for that category.');

    return await serveMedia({
      media: category.cover,
      request,
      disposition: 'inline',
      cacheControl: 'public, max-age=604800, immutable',
    });
  } catch (error) {
    return errorResponse(error, { route: 'category.cover', audience: 'public' });
  }
}

export const GET = handle;
export const HEAD = handle;
