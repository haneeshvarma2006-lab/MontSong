import { limitPublic } from '@/lib/auth/guard';
import { SEARCH_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas } from '@/lib/db';
import { errorResponse, json } from '@/lib/http/respond';
import { getCategoryBySlug } from '@/lib/repositories/categories';
import { searchAudio } from '@/lib/repositories/search';
import { toPublicAudio } from '@/lib/serializers';
import { parseSearchParams } from '@/lib/validation/parse';
import { searchQuerySchema } from '@/lib/validation/schemas';

/**
 * GET /api/search?q=&category=&type=&limit=
 *
 * Server-side search, so it stays correct as the library grows rather than
 * shipping the whole catalogue to the browser. The client debounces; this
 * endpoint is rate limited per address.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    limitPublic(request, SEARCH_RULE, 'search');

    const url = new URL(request.url);
    const query = parseSearchParams(url.searchParams, searchQuerySchema);

    let categoryId: string | undefined;
    if (query.category) {
      const category = await getCategoryBySlug(query.category, { publishedOnly: true });
      // An unknown category slug yields no results rather than every result.
      if (!category) return json({ results: [], total: 0 });
      categoryId = category.id;
    }

    const results = await searchAudio({
      query: query.q,
      categoryId,
      type: query.type,
      limit: query.limit,
      publishedOnly: true,
    });

    return json({ results: results.map(toPublicAudio), total: results.length });
  } catch (error) {
    return errorResponse(error, { route: 'search', audience: 'public' });
  }
}
