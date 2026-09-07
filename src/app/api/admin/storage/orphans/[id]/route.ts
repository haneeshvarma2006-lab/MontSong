import { requireAdmin } from '@/lib/auth/guard';
import { ADMIN_WRITE_RULE } from '@/lib/auth/rate-limit';
import { ensurePragmas } from '@/lib/db';
import { errorResponse, json } from '@/lib/http/respond';
import { adoptOrphan, discardOrphan } from '@/lib/upload/service';

/**
 * Reconciliation actions for an upload that reached Telegram but never became
 * a track.
 *
 *   POST   — adopt: create the media row from the identifiers already stored,
 *            no re-upload needed. The file becomes usable again.
 *   DELETE — discard: remove the Telegram message and the record.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: ADMIN_WRITE_RULE, bucket: 'storage' });
    const { id } = await context.params;
    const media = await adoptOrphan(id);
    return json({
      ok: true,
      media: { id: media.id, fileName: media.fileName, fileSize: media.fileSize },
    });
  } catch (error) {
    return errorResponse(error, { route: 'admin.storage.adopt', audience: 'admin' });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ensurePragmas();
    await requireAdmin(request, { rule: ADMIN_WRITE_RULE, bucket: 'storage' });
    const { id } = await context.params;
    const result = await discardOrphan(id);
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error, { route: 'admin.storage.discard', audience: 'admin' });
  }
}
