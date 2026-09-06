import { headers } from 'next/headers';

import { assertSameOrigin, clientIp } from '@/lib/auth/guard';
import { verifyPassword, safeStringEqual } from '@/lib/auth/password';
import { consume, LOGIN_RULE, reset } from '@/lib/auth/rate-limit';
import {
  createSession,
  ensureAdminUser,
  hashClientIp,
  writeSessionCookies,
} from '@/lib/auth/session';
import { ensurePragmas, prisma } from '@/lib/db';
import { rateLimited, unauthorized } from '@/lib/errors';
import { errorResponse, json } from '@/lib/http/respond';
import { logger } from '@/lib/logger';
import { parseJsonBody } from '@/lib/validation/parse';
import { loginSchema } from '@/lib/validation/schemas';

/**
 * POST /api/admin/auth/login
 *
 * Three independent brakes on guessing:
 *
 *  1. A per-address token bucket (5 attempts, one back every 30s), so a single
 *     source cannot spray attempts.
 *  2. A per-account lockout that escalates with consecutive failures, so a
 *     distributed attempt against the one known account still stalls.
 *  3. A constant-ish response cost: a wrong username still runs a password
 *     verification against the stored hash, so timing does not reveal whether
 *     the username was right.
 *
 * The response says only "those details did not match" in every failure case.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Lockout thresholds, in consecutive failures -> minutes locked. */
function lockoutMinutes(failures: number): number {
  if (failures >= 20) return 60;
  if (failures >= 10) return 15;
  if (failures >= 5) return 2;
  return 0;
}

export async function POST(request: Request): Promise<Response> {
  try {
    await ensurePragmas();
    assertSameOrigin(request);

    const ip = clientIp(request);
    const bucketKey = `login:${hashClientIp(ip) ?? 'anonymous'}`;
    const limit = consume(bucketKey, LOGIN_RULE);
    if (!limit.allowed) {
      throw rateLimited('Too many sign-in attempts. Wait a moment and try again.', limit.retryAfterSeconds);
    }

    const input = await parseJsonBody(request, loginSchema);
    const user = await ensureAdminUser();

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw rateLimited('Too many failed attempts. This account is temporarily locked.', seconds);
    }

    // Both checks always run: short-circuiting on the username would make a
    // wrong username measurably faster than a wrong password.
    const usernameOk = safeStringEqual(input.username, user.username);
    const passwordOk = await verifyPassword(input.password, user.passwordHash);

    if (!usernameOk || !passwordOk) {
      const failures = user.failedLoginCount + 1;
      const minutes = lockoutMinutes(failures);
      await prisma.adminUser.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failures,
          lockedUntil: minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000) : null,
        },
      });
      logger.warn('auth.login_failed', { failures, locked: minutes > 0 });
      throw unauthorized('Those details did not match.');
    }

    const headerList = await headers();
    const session = await createSession(user, {
      userAgent: headerList.get('user-agent'),
      ipHash: hashClientIp(ip),
    });

    await prisma.adminUser.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    reset(bucketKey);
    await writeSessionCookies(session.token, session.csrfToken, session.expiresAt);
    logger.info('auth.login_ok', { userId: user.id });

    return json({
      ok: true,
      csrfToken: session.csrfToken,
      user: { username: user.username },
    });
  } catch (error) {
    return errorResponse(error, { route: 'admin.login', audience: 'public' });
  }
}
