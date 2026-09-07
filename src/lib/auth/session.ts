import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_SLIDE_INTERVAL_MS,
  SESSION_TTL_MS,
} from '../constants';
import { prisma } from '../db';
import { getConfig } from '../env';
import { createId, createToken } from '../ids';
import { logger } from '../logger';

import type { AdminUser, Session } from '@/generated/prisma';

/**
 * Server-side sessions.
 *
 * The cookie carries an opaque 32-byte random token. Only a keyed hash of it
 * is stored, so read access to the database does not yield a usable session —
 * the same reasoning as never storing a plaintext password.
 *
 * Revocation works three ways, and all three are real rather than cosmetic:
 * deleting the row, rotating AUTH_SECRET (which changes the key every stored
 * hash was computed under), and rotating ADMIN_PASSWORD_HASH (checked against
 * the session's own user on every request).
 *
 * Cookie flags: HttpOnly (no script access), SameSite=Lax (the admin is only
 * ever reached by top-level navigation, and Lax still blocks cross-site POSTs),
 * Secure in production, and Path=/ so the middleware sees it.
 */

export interface AuthenticatedSession {
  readonly session: Session;
  readonly user: AdminUser;
}

/**
 * Hash a session token for storage, keyed with AUTH_SECRET.
 *
 * The key is what makes rotating AUTH_SECRET a real revocation: every stored
 * hash was computed under the old key, so after a rotation no presented token
 * can hash to a stored row and every session is gone by construction. An
 * unkeyed digest here would leave `sign out everywhere` documented but
 * inoperative — the owner rotates the secret, believes they have ejected
 * whoever held a stolen cookie, and that cookie keeps working.
 *
 * It is still a hash, not an encryption: the database never holds anything
 * that can be replayed as a cookie.
 */
function hashToken(token: string): string {
  return createHmac('sha256', getConfig().auth.secret).update(token).digest('hex');
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Bootstrap the single owner row from the environment.
 *
 * There is no registration flow by design: the owner is whoever holds
 * ADMIN_USERNAME and ADMIN_PASSWORD_HASH. This reconciles the stored row with
 * the environment on sign-in. Existing sessions do not wait for that:
 * getSessionFromToken rejects any session whose user still carries a different
 * password hash, so a rotation takes effect on the next request either way.
 */
export async function ensureAdminUser(): Promise<AdminUser> {
  const config = getConfig();
  const existing = await prisma.adminUser.findFirst();

  if (!existing) {
    return prisma.adminUser.create({
      data: {
        id: createId(),
        username: config.auth.username,
        passwordHash: config.auth.passwordHash,
      },
    });
  }

  const usernameChanged = existing.username !== config.auth.username;
  const passwordChanged = existing.passwordHash !== config.auth.passwordHash;

  if (!usernameChanged && !passwordChanged) return existing;

  const updated = await prisma.adminUser.update({
    where: { id: existing.id },
    data: {
      username: config.auth.username,
      passwordHash: config.auth.passwordHash,
      // Credentials changed out from under the running sessions; clear the
      // lockout so the owner is not locked out by their own rotation.
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  if (passwordChanged) {
    const { count } = await prisma.session.deleteMany({ where: { userId: existing.id } });
    logger.info('auth.credentials_rotated', { revokedSessions: count });
  }

  return updated;
}

export async function createSession(
  user: AdminUser,
  context: { userAgent?: string | null; ipHash?: string | null } = {},
): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = createToken(32);
  const csrfSecret = createToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      id: createId(),
      userId: user.id,
      tokenHash: hashToken(token),
      csrfSecret,
      expiresAt,
      userAgent: context.userAgent?.slice(0, 300) ?? null,
      ipHash: context.ipHash ?? null,
    },
  });

  return { token, csrfToken: deriveCsrfToken(csrfSecret), expiresAt };
}

/**
 * Write both cookies. The CSRF cookie is deliberately readable by scripts —
 * that is the whole point of the double-submit pattern: same-origin JavaScript
 * can echo it back in a header, cross-origin JavaScript cannot read it.
 */
export async function writeSessionCookies(token: string, csrfToken: string, expiresAt: Date) {
  const store = await cookies();

  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    expires: expiresAt,
  });

  store.set(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, '', { path: '/', expires: new Date(0), httpOnly: true });
  store.set(CSRF_COOKIE_NAME, '', { path: '/', expires: new Date(0) });
}

/**
 * Look up the session behind the current request's cookie.
 *
 * Expired sessions are deleted on sight rather than merely rejected, so the
 * table does not accumulate dead rows without a scheduled job.
 */
export async function getSessionFromToken(token: string | undefined): Promise<AuthenticatedSession | null> {
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  // A session is only valid while the credential it was minted under is still
  // the configured one. The stored hash is reconciled with the environment by
  // ensureAdminUser, which runs on sign-in — so without this check, changing
  // ADMIN_PASSWORD_HASH and restarting would revoke nothing until somebody
  // happened to attempt a login, which an attacker holding a live cookie has
  // no reason to do. Comparing here makes the rotation take effect on the
  // attacker's very next request instead.
  if (session.user.passwordHash !== getConfig().auth.passwordHash) {
    await prisma.session.deleteMany({ where: { userId: session.userId } }).catch(() => undefined);
    logger.info('auth.session_rejected_stale_credential', { userId: session.userId });
    return null;
  }

  // Slide the expiry, but only occasionally: writing on every request would
  // turn every page view into a database write.
  const age = Date.now() - session.lastSeenAt.getTime();
  if (age > SESSION_SLIDE_INTERVAL_MS) {
    void prisma.session
      .update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
      })
      .catch(() => undefined);
  }

  return { session, user: session.user };
}

export async function getCurrentSession(): Promise<AuthenticatedSession | null> {
  const store = await cookies();
  return getSessionFromToken(store.get(SESSION_COOKIE_NAME)?.value);
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { userId } });
  return count;
}

export async function pruneExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return count;
}

// --- CSRF -------------------------------------------------------------------

/**
 * Derive the CSRF token from the session's own secret, keyed by AUTH_SECRET.
 *
 * Deriving rather than storing means the token cannot be forged without both
 * the server secret and the per-session secret, and it stays stable for the
 * life of the session so a long-lived admin tab keeps working.
 */
export function deriveCsrfToken(csrfSecret: string): string {
  return createHmac('sha256', getConfig().auth.secret).update(csrfSecret).digest('base64url');
}

export function csrfTokenMatches(session: Session, presented: string | null | undefined): boolean {
  if (!presented) return false;
  const expected = deriveCsrfToken(session.csrfSecret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Coarse, salted client fingerprint for lockout bookkeeping. Never reversible. */
export function hashClientIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHmac('sha256', getConfig().auth.secret).update(ip).digest('hex').slice(0, 32);
}
