import type { MetadataRoute } from 'next';

import { siteUrl } from '@/lib/site';

/**
 * robots.txt
 *
 * The library is meant to be found. The admin area and the API are not: the
 * media endpoints are for browsers playing and downloading, and having a
 * crawler pull every track would burn Telegram bandwidth for nothing.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/admin/', '/api/', '/search?'],
      },
    ],
    sitemap: siteUrl('/sitemap.xml'),
    host: siteUrl(),
  };
}
