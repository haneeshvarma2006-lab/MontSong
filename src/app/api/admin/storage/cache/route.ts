import { requireAdmin } from '@/lib/auth/guard';
import { ADMIN_WRITE_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas } from '@/lib/db';
import { errorResponse, json } from '@/lib/http/respond';
import { clearCache } from '@/lib/media/cache';

/**
 * DELETE /api/admin/storage/cache — empty the on-disk media cache.
 *
 * Always safe: every entry is a copy of something Telegram still holds, and the
 * next request for a track re-fills it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: ADMIN_WRITE_RULE, bucket: 'storage' });
    const cleared = await clearCache();
    return json({ ok: true, cleared });
  } catch (error) {
    return errorResponse(error, { route: 'admin.storage.cache', audience: 'admin' });
  }
}
