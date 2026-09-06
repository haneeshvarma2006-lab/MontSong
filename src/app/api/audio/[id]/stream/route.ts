import { MEDIA_RULE } from '@/lib/auth/rate-limit';
import { limitPublic } from '@/lib/auth/guard';
import { ensurePragmas } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { serveMedia } from '@/lib/media/serve';
import { getPlayableAudio, recordDownload } from '@/lib/repositories/audio';
import { errorResponse } from '@/lib/http/respond';

/**
 * GET /api/audio/:id/stream
 *
 * Serves audio for playback: `inline` disposition, range requests honoured, and
 * an ETag so a repeat listen costs nothing. See src/lib/media/serve.ts for the
 * cache-then-serve strategy.
 *
 * The Node runtime is required — this handler streams a file of arbitrary size
 * and holds a connection open for the length of a track. Edge runtimes cap both.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensurePragmas();
    limitPublic(request, MEDIA_RULE, 'stream');

    const { id } = await context.params;
    const audio = await getPlayableAudio(id);
    if (!audio) throw notFound('That track is not available.');

    const response = await serveMedia({
      media: audio.media,
      request,
      disposition: 'inline',
    });

    // Count a play once per session start, not once per seek: a range request
    // that does not begin at byte zero is the browser continuing, not starting.
    const range = request.headers.get('range');
    const isStart = !range || /^bytes\s*=\s*0-/.test(range);
    if (request.method === 'GET' && isStart) {
      void recordDownload(audio.id, 'stream');
    }

    return response;
  } catch (error) {
    return errorResponse(error, { route: 'audio.stream', audience: 'public' });
  }
}

export const GET = handle;
export const HEAD = handle;
