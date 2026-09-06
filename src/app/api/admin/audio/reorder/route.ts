import { requireAdmin } from '@/lib/auth/guard';
import { ADMIN_WRITE_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas } from '@/lib/db';
import { errorResponse, json } from '@/lib/http/respond';
import { reorderAudio } from '@/lib/repositories/audio';
import { parseJsonBody } from '@/lib/validation/parse';
import { reorderSchema } from '@/lib/validation/schemas';

/** POST /api/admin/audio/reorder */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: ADMIN_WRITE_RULE, bucket: 'audio' });
    const { ids } = await parseJsonBody(request, reorderSchema);
    await reorderAudio(ids);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error, { route: 'admin.audio.reorder', audience: 'admin' });
  }
}
