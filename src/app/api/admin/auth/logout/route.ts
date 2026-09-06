import { readSessionCookie } from '@/lib/auth/guard';
import { clearSessionCookies, getSessionFromToken, revokeSession } from '@/lib/auth/session';
import { ensurePragmas } from '@/lib/db';
import { errorResponse, json } from '@/lib/http/respond';

/**
 * POST /api/admin/auth/logout
 *
 * Deletes the session row, so the cookie is dead server-side even if a copy of
 * it was captured. Deliberately succeeds for an already-invalid session: a
 * "sign out" that errors is worse than one that is idempotent, and there is no
 * CSRF risk in logging someone out of their own session.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    await ensurePragmas();

    const authenticated = await getSessionFromToken(readSessionCookie(request));
    if (authenticated) await revokeSession(authenticated.session.id);

    await clearSessionCookies();
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error, { route: 'admin.logout', audience: 'public' });
  }
}
