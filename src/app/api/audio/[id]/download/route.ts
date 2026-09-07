import { EXTENSION_BY_MIME } from '@/lib/constants';
import { MEDIA_RULE } from '@/lib/auth/rate-limit';
import { limitPublic } from '@/lib/auth/guard';
import { ensurePragmas } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { downloadFileName } from '@/lib/media/sniff';
import { serveMedia } from '@/lib/media/serve';
import { getPlayableAudio, recordDownload } from '@/lib/repositories/audio';
import { errorResponse } from '@/lib/http/respond';

/**
 * GET /api/audio/:id/download
 *
 * The visitor's browser downloads the file from this origin. No redirect, no
 * Telegram URL, no Telegram app — the bytes are proxied (or served from the
 * local cache) with an `attachment` disposition and a filename derived from the
 * track's slug, so what lands in their Downloads folder reads as
 * `tamil-og-ringtone.mp3`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensurePragmas();
    limitPublic(request, MEDIA_RULE, 'download');

    const { id } = await context.params;
    const audio = await getPlayableAudio(id);
    if (!audio) throw notFound('That track is not available.');

    const response = await serveMedia({
      media: audio.media,
      request,
      disposition: 'attachment',
      downloadName: downloadFileName(audio.slug, audio.media.mimeType, EXTENSION_BY_MIME),
      // A download is a one-shot fetch; let the browser cache it briefly but
      // never let a shared cache hold it as the canonical copy.
      cacheControl: 'private, max-age=300',
    });

    // Only a full-file GET counts. A resumed or partial fetch is the same
    // download continuing, and would otherwise inflate the number.
    if (request.method === 'GET' && !request.headers.get('range')) {
      void recordDownload(audio.id, 'download');
    }

    return response;
  } catch (error) {
    return errorResponse(error, { route: 'audio.download', audience: 'public' });
  }
}

export const GET = handle;
export const HEAD = handle;
