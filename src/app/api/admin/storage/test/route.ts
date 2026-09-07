import { requireAdmin } from '@/lib/auth/guard';
import { ADMIN_WRITE_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas } from '@/lib/db';
import { errorResponse, json } from '@/lib/http/respond';
import { getTelegramClient } from '@/lib/telegram/client';

/**
 * POST /api/admin/storage/test — verify the storage connection end to end:
 * the token is accepted, the storage chat resolves, and the bot can see it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: ADMIN_WRITE_RULE, bucket: 'storage' });
    const report = await getTelegramClient().testConnection();
    return json({ report });
  } catch (error) {
    return errorResponse(error, { route: 'admin.storage.test', audience: 'admin' });
  }
}
