import { requireAdmin } from '@/lib/auth/guard';
import { ensurePragmas } from '@/lib/db';
import {
  getConfig,
  getConfigWarnings,
  TELEGRAM_CLOUD_DOWNLOAD_LIMIT_BYTES,
  TELEGRAM_LOCAL_UPLOAD_LIMIT_BYTES,
} from '@/lib/env';
import { errorResponse, json } from '@/lib/http/respond';
import { cacheStats } from '@/lib/media/cache';
import { listOrphanedUploads } from '@/lib/upload/service';

/**
 * GET /api/admin/storage
 *
 * The diagnostics screen: which Telegram mode is in effect and what it can
 * actually hold, how full the media cache is, and every upload that reached
 * storage but never became a track.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request);

    const config = getConfig();
    const usingCloud = config.telegram.apiBaseUrl === 'https://api.telegram.org';

    const [cache, orphans] = await Promise.all([cacheStats(), listOrphanedUploads()]);

    return json({
      mode: usingCloud ? 'cloud' : 'local-server',
      limits: {
        maxAudioBytes: config.uploads.maxAudioBytes,
        maxImageBytes: config.uploads.maxImageBytes,
        telegramCeilingBytes: usingCloud
          ? TELEGRAM_CLOUD_DOWNLOAD_LIMIT_BYTES
          : TELEGRAM_LOCAL_UPLOAD_LIMIT_BYTES,
        // Stated plainly because it surprises people: on the cloud Bot API a
        // bot may send 50 MB but can only fetch 20 MB back, and this site has
        // to fetch every file back.
        explanation: usingCloud
          ? 'Cloud Bot API: a bot can send up to 50 MB but getFile only returns files up to 20 MB. Since every track has to be served back to visitors, 20 MB is the real ceiling.'
          : 'Local Bot API server: uploads up to 2000 MB, downloads with no size limit.',
      },
      cache,
      orphans,
      warnings: getConfigWarnings(),
    });
  } catch (error) {
    return errorResponse(error, { route: 'admin.storage', audience: 'admin' });
  }
}
