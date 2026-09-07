import type { NextConfig } from 'next';

/**
 * Security headers.
 *
 * The Content-Security-Policy is deliberately *not* here: it carries a
 * per-request nonce and so has to be built per request, which `src/middleware.ts`
 * does. Everything below is static and identical for every response.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  // Browsers ignore HSTS delivered over plain HTTP, so this is inert during
  // local development and active the moment the site is served over TLS.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  /**
   * Deliberately not `output: 'standalone'`.
   *
   * Standalone tracing does not reliably pick up better-sqlite3's native
   * binding or the Prisma CLI, both of which this deployment needs at runtime
   * — the CLI because the container applies migrations on start. The Docker
   * image installs production dependencies properly instead and runs the
   * ordinary Next server, which also means `npm run build && npm start` behaves
   * identically everywhere. See docs/DEPLOYMENT.md.
   */
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  productionBrowserSourceMaps: false,
  experimental: {
    // Audio/cover uploads are streamed through a route handler, never through
    // a Server Action, so the default Server Action body limit stays small.
    serverActions: { bodySizeLimit: '1mb' },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
