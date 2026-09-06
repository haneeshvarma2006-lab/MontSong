import 'server-only';

import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '../constants';
import { getConfig } from '../env';
import { forbidden, rateLimited, unauthorized } from '../errors';
import { consume, type RateLimitRule } from './rate-limit';
import { csrfTokenMatches, getSessionFromToken, hashClientIp, type AuthenticatedSession } from './session';

/**
 * Server-side authorisation for admin endpoints.
 *
 * Hiding the admin UI is not a control. Every admin route calls
 * `requireAdmin` before it touches anything, so a request that never renders a
 * page — curl, a script, a stale tab — is rejected identically.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Read the client address, trusting only the proxy header the deployment sets. */
export function clientIp(request: Request): string | null {
  // Documented deployment puts one reverse proxy in front, so the left-most
  // entry of X-Forwarded-For is the client. Behind no proxy this is absent and
  // rate limiting degrades to a single shared bucket, which is still a limit.
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() ?? null;
}

/**
 * Reject cross-site state-changing requests.
 *
 * Two independent checks, because either alone has gaps: an Origin/Referer
 * check (covers clients that send them, which is every browser for a POST) and
 * a double-submit CSRF token (covers the rest, and does not depend on headers
 * a proxy might strip).
 */
export function assertSameOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method)) return;

  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  const candidate = origin ?? (referer ? safeOrigin(referer) : null);

  if (!candidate) {
    // No Origin and no Referer on a state-changing request: not a browser form
    // post we recognise. The CSRF token check still has to pass, but refuse
    // here too rather than trusting a header-less caller.
    throw forbidden('This request could not be verified as coming from the admin interface.');
  }

  if (!allowedOrigins(request).has(candidate)) {
    throw forbidden('This request came from an unrecognised origin.');
  }
}

/**
 * The origins a state-changing request may legitimately claim to come from.
 *
 * Built from the request itself rather than from configuration alone. The
 * subtlety is the scheme: behind a TLS-terminating reverse proxy — the
 * documented deployment — the application speaks plain HTTP while the browser
 * sends `Origin: https://…`, so the scheme has to come from
 * `X-Forwarded-Proto`. Deriving it from `NEXT_PUBLIC_SITE_URL` alone would
 * reject every admin write whenever the site is reached by any other name
 * (an IP address during setup, a staging hostname, `localhost` versus
 * `127.0.0.1`), which is a confusing failure for something that is not a
 * security boundary on its own — the per-session CSRF token is.
 */
function allowedOrigins(request: Request): Set<string> {
  const config = getConfig();
  const allowed = new Set<string>(config.trustedOrigins);
  allowed.add(config.site.url);

  const host = request.headers.get('host');
  if (host) {
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const requestProto = safeProtocol(request.url);
    const scheme = forwardedProto ?? requestProto ?? 'https';
    allowed.add(`${scheme}://${host}`);
  }

  return allowed;
}

function safeProtocol(url: string): string | null {
  try {
    return new URL(url).protocol.replace(':', '');
  } catch {
    return null;
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export interface GuardOptions {
  /** Apply a rate limit bucket keyed by session and route. */
  readonly rule?: RateLimitRule;
  readonly bucket?: string;
  /** Skip the CSRF/origin checks. Only for GET-shaped admin reads. */
  readonly skipCsrf?: boolean;
}

/**
 * The single entry point every admin route uses.
 *
 * Order matters: authenticate first so an anonymous flood cannot consume an
 * authenticated caller's rate budget, then verify the request's provenance,
 * then spend a token.
 */
export async function requireAdmin(
  request: Request,
  options: GuardOptions = {},
): Promise<AuthenticatedSession> {
  const token = readSessionCookie(request);
  const authenticated = await getSessionFromToken(token);

  if (!authenticated) {
    throw unauthorized('Sign in to continue.');
  }

  if (!SAFE_METHODS.has(request.method) && !options.skipCsrf) {
    assertSameOrigin(request);

    const presented =
      request.headers.get(CSRF_HEADER_NAME) ?? request.headers.get(CSRF_HEADER_NAME.toUpperCase());

    if (!csrfTokenMatches(authenticated.session, presented)) {
      throw forbidden('Your session token was missing or stale. Reload the page and try again.');
    }
  }

  if (options.rule) {
    const key = `${options.bucket ?? 'admin'}:${authenticated.session.id}`;
    const result = consume(key, options.rule);
    if (!result.allowed) {
      throw rateLimited(
        'You are doing that too quickly. Give it a moment.',
        result.retryAfterSeconds,
      );
    }
  }

  return authenticated;
}

/**
 * Rate-limit an anonymous public request by client address.
 * Falls back to a single shared bucket when no address is visible.
 */
export function limitPublic(request: Request, rule: RateLimitRule, bucket: string): void {
  const ip = clientIp(request);
  const key = `${bucket}:${hashClientIp(ip) ?? 'anonymous'}`;
  const result = consume(key, rule);
  if (!result.allowed) {
    throw rateLimited('Too many requests. Please slow down.', result.retryAfterSeconds);
  }
}

/** Parse the session cookie out of a raw Request, for route handlers. */
export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name === SESSION_COOKIE_NAME) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}
