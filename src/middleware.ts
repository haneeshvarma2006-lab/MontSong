import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE_NAME } from '@/lib/constants';

/**
 * Two jobs, both of which have to happen before a page is rendered.
 *
 * ## 1. A per-request Content-Security-Policy nonce
 *
 * A static CSP for a React application has to allow `script-src
 * 'unsafe-inline'`, because the framework emits inline scripts for hydration —
 * which weakens the policy to the point where it would not stop an injected
 * `<script>`. Generating a fresh nonce per request and naming it in the policy
 * removes that allowance: only scripts carrying this request's nonce run.
 *
 * `'strict-dynamic'` lets a nonced script load further scripts (Next's chunk
 * loader does exactly this) without having to enumerate every chunk URL.
 *
 * The nonce is passed down on a request header, which Next reads and applies to
 * the scripts it emits.
 *
 * ## 2. An edge-level gate for the admin area
 *
 * This is *not* the authorisation check — the edge runtime has no database, so
 * it cannot tell a valid session cookie from a forged one. Both real checks sit
 * behind it: `(dashboard)/layout.tsx` verifies the session before rendering,
 * and every `/api/admin` route verifies it again for itself.
 *
 * What it adds is that a request with no session cookie at all — the ordinary
 * anonymous case, every crawler included — is redirected before Next renders
 * anything, so admin markup is never generated for it.
 */

const isDev = process.env.NODE_ENV === 'development';

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    // Audio is only ever served from this origin. If a change ever tried to
    // hand the browser a storage-backend URL, the browser would block it.
    "media-src 'self' blob:",
    "font-src 'self' data:",
    // Next injects a style element for CSS chunks, and inline styles carry no
    // script capability.
    "style-src 'self' 'unsafe-inline'",
    // 'unsafe-eval' is required by the development bundler only.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce);

  const { pathname } = request.nextUrl;
  const needsAdminSession =
    (pathname === '/admin' || pathname.startsWith('/admin/')) && pathname !== '/admin/login';

  if (needsAdminSession && !request.cookies.get(SESSION_COOKIE_NAME)?.value) {
    const url = request.nextUrl.clone();
    url.pathname = '/admin/login';
    url.search = '';
    const redirect = NextResponse.redirect(url);
    redirect.headers.set('Content-Security-Policy', csp);
    return redirect;
  }

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    /**
     * Everything except Next's own static output and the media endpoints.
     *
     * `/api/audio` is excluded deliberately: those routes stream bytes rather
     * than documents, so a CSP means nothing to them, and running middleware on
     * every range request during playback would be pure overhead.
     */
    '/((?!_next/static|_next/image|api/audio|favicon.ico|icon.svg).*)',
  ],
};
