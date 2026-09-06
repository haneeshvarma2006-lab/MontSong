import { limitPublic } from '@/lib/auth/guard';
import { SEARCH_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas } from '@/lib/db';
import { errorResponse, json } from '@/lib/http/respond';
import { listCategories } from '@/lib/repositories/categories';
import { toPublicCategory } from '@/lib/serializers';

/** GET /api/categories — the published categories, in the owner's order. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    limitPublic(request, SEARCH_RULE, 'categories');

    const categories = await listCategories({ publishedOnly: true, withCounts: true });
    return json({ categories: categories.map(toPublicCategory) });
  } catch (error) {
    return errorResponse(error, { route: 'categories.list', audience: 'public' });
  }
}
