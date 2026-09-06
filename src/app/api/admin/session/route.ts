import { requireAdmin } from '@/lib/auth/guard';
import { deriveCsrfToken } from '@/lib/auth/session';
import { ensurePragmas } from '@/lib/db';
import { errorResponse, json } from '@/lib/http/respond';

/**
 * GET /api/admin/session — who am I, and a fresh CSRF token.
 *
 * The admin client calls this on load so a tab restored after a restart picks
 * up a valid token instead of failing its first write.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    const { user, session } = await requireAdmin(request);
    return json({
      user: { username: user.username, lastLoginAt: user.lastLoginAt?.toISOString() ?? null },
      csrfToken: deriveCsrfToken(session.csrfSecret),
      expiresAt: session.expiresAt.toISOString(),
    });
  } catch (error) {
    return errorResponse(error, { route: 'admin.session', audience: 'public' });
  }
}
