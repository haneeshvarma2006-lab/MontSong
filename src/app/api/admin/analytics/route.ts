import { requireAdmin } from '@/lib/auth/guard';
import { ensurePragmas } from '@/lib/db';
import { errorResponse, json } from '@/lib/http/respond';
import {
  getDailyDownloads,
  getDashboardStats,
  getPopularTracks,
  getRecentUploads,
} from '@/lib/repositories/analytics';

/** GET /api/admin/analytics — everything the dashboard renders, in one call. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request);

    const [stats, popular, recent, daily] = await Promise.all([
      getDashboardStats(),
      getPopularTracks(10),
      getRecentUploads(8),
      getDailyDownloads(30),
    ]);

    return json({ stats, popular, recent, daily });
  } catch (error) {
    return errorResponse(error, { route: 'admin.analytics', audience: 'admin' });
  }
}
