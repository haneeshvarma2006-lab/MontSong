import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ChevronLeftIcon } from '@/components/icons';
import { TrackList } from '@/components/TrackList';
import { listPublicAudio } from '@/lib/repositories/audio';
import { getCategoryBySlug } from '@/lib/repositories/categories';
import { toPublicAudio } from '@/lib/serializers';
import { getSiteCopy, siteUrl } from '@/lib/site';

/**
 * A category's tracks, at a clean URL: /category/tamil-ogs
 *
 * Nothing about the category is hardcoded — the slug is looked up at request
 * time, so a category created a minute ago is already reachable and indexable.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const [category, copy] = await Promise.all([
    getCategoryBySlug(slug, { publishedOnly: true }),
    getSiteCopy(),
  ]);

  if (!category) return { title: 'Not found', robots: { index: false, follow: false } };

  const description =
    category.description ?? `${category.name} — listen and download from ${copy.name}.`;

  return {
    title: category.name,
    description,
    alternates: { canonical: `/category/${category.slug}` },
    openGraph: {
      type: 'website',
      title: `${category.name} · ${copy.name}`,
      description,
      url: siteUrl(`/category/${category.slug}`),
    },
  };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug, { publishedOnly: true });
  if (!category) notFound();

  const tracks = await listPublicAudio({ categoryId: category.id, limit: 200, orderBy: 'order' });

  return (
    <div className="page">
      <section className="hero" style={{ paddingBottom: 'var(--s-6)' }}>
        <Link href="/" className="chip">
          <ChevronLeftIcon size={14} />
          All categories
        </Link>
        <h1 className="hero__title" style={{ marginTop: 'var(--s-5)' }}>
          {category.icon ? <span aria-hidden="true">{category.icon} </span> : null}
          {category.name}
        </h1>
        {category.description ? <p className="hero__tagline">{category.description}</p> : null}
      </section>

      <TrackList
        tracks={tracks.map(toPublicAudio)}
        emptyTitle="Nothing in this category yet"
        emptyBody="Tracks added to this category will show up here."
      />
    </div>
  );
}
