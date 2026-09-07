import { requireAdmin } from '@/lib/auth/guard';
import { ADMIN_WRITE_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas } from '@/lib/db';
import { errorResponse, json } from '@/lib/http/respond';
import { createCategory, listCategories } from '@/lib/repositories/categories';
import { toAdminCategory } from '@/lib/serializers';
import { parseJsonBody } from '@/lib/validation/parse';
import { createCategorySchema } from '@/lib/validation/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/admin/categories — every category, published or not. */
export async function GET(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request);
    const categories = await listCategories({ withCounts: true });
    return json({ categories: categories.map(toAdminCategory) });
  } catch (error) {
    return errorResponse(error, { route: 'admin.categories.list', audience: 'admin' });
  }
}

/** POST /api/admin/categories — create one. */
export async function POST(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: ADMIN_WRITE_RULE, bucket: 'categories' });
    const input = await parseJsonBody(request, createCategorySchema);
    const category = await createCategory(input);
    return json({ category: toAdminCategory({ ...category, audioCount: 0 }) }, { status: 201 });
  } catch (error) {
    return errorResponse(error, { route: 'admin.categories.create', audience: 'admin' });
  }
}
