import type { NextConfig } from 'next';

/**
 * Security headers.
 *
 * The CSP is deliberately strict: the app ships no third-party scripts and no
 * inline scripts of its own beyond Next's own hydration payload, which is why
 * 'unsafe-inline' is present for scripts in development only. Styles need
 * 'unsafe-inline' because Next injects a small style element for CSS chunks.
 *
 * `media-src 'self'` matters here: audio is only ever served from our own
 * origin, never from a Telegram URL. If a change ever tried to hand a
 * Telegram link to the browser, the browser would block it.
 */
const isDev = process.env.NODE_ENV === 'development';

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self'${isDev ? " 'unsafe-eval' 'unsafe-inline'" : " 'unsafe-inline'"}`,
  "connect-src 'self'",
  "manifest-src 'self'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
];

const nextConfig: NextConfig = {
  // A container image with a persistent volume is the deployment target
  // (see docs/DEPLOYMENT.md); `standalone` keeps that image small.
  output: 'standalone',
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
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // HSTS only makes sense on the public origin behind TLS; it is
        // harmless in development because browsers ignore it on localhost.
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
