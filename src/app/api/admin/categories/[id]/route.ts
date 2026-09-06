import { requireAdmin } from '@/lib/auth/guard';
import { ADMIN_WRITE_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas } from '@/lib/db';
import { badRequest } from '@/lib/errors';
import { errorResponse, json } from '@/lib/http/respond';
import { deleteCategory, updateCategory } from '@/lib/repositories/categories';
import { toAdminCategory } from '@/lib/serializers';
import { parseJsonBody } from '@/lib/validation/parse';
import { updateCategorySchema } from '@/lib/validation/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PATCH /api/admin/categories/:id */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: ADMIN_WRITE_RULE, bucket: 'categories' });
    const { id } = await context.params;
    const input = await parseJsonBody(request, updateCategorySchema);
    const category = await updateCategory(id, input);
    return json({ category: toAdminCategory(category) });
  } catch (error) {
    return errorResponse(error, { route: 'admin.categories.update', audience: 'admin' });
  }
}

/**
 * DELETE /api/admin/categories/:id?mode=unassign|reassign&target=<id>
 *
 * Tracks are never deleted along with their category. The caller has to say
 * whether they become uncategorised or move somewhere specific, and the
 * response reports how many were affected so the UI can confirm what happened.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: ADMIN_WRITE_RULE, bucket: 'categories' });

    const { id } = await context.params;
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') ?? 'unassign';
    const target = url.searchParams.get('target') ?? undefined;

    if (mode !== 'unassign' && mode !== 'reassign') {
      throw badRequest('mode must be "unassign" or "reassign".');
    }

    const result = await deleteCategory(id, { mode, targetCategoryId: target });
    return json({ ok: true, movedAudio: result.movedAudio });
  } catch (error) {
    return errorResponse(error, { route: 'admin.categories.delete', audience: 'admin' });
  }
}
