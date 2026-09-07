import type { MetadataRoute } from 'next';

import { prisma } from '@/lib/db';
import { siteUrl } from '@/lib/site';

/**
 * sitemap.xml, generated from what is actually published.
 *
 * Only published rows appear, so unpublishing a track removes it from the
 * sitemap on the next crawl rather than leaving a promise of a 404 behind.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [categories, tracks] = await Promise.all([
    prisma.category.findMany({
      where: { isPublished: true },
      select: { slug: true, updatedAt: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.audio.findMany({
      where: { isPublished: true },
      select: { slug: true, updatedAt: true },
      orderBy: { createdAt: 'desc' },
      // A sitemap file may hold 50,000 URLs; stay well inside that.
      take: 20000,
    }),
  ]);

  return [
    {
      url: siteUrl('/'),
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
    ...categories.map((category) => ({
      url: siteUrl(`/category/${category.slug}`),
      lastModified: category.updatedAt,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
    ...tracks.map((track) => ({
      url: siteUrl(`/song/${track.slug}`),
      lastModified: track.updatedAt,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
  ];
}
