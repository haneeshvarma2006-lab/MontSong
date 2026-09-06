import Link from 'next/link';

import { CategoryGrid } from '@/components/CategoryGrid';
import { SearchBox } from '@/components/SearchBox';
import { TrackList } from '@/components/TrackList';
import { listCategories } from '@/lib/repositories/categories';
import { listFeaturedAudio, listPublicAudio } from '@/lib/repositories/audio';
import { toPublicAudio, toPublicCategory } from '@/lib/serializers';
import { getSiteCopy } from '@/lib/site';

/**
 * Home.
 *
 * Rendered on the server on every request so a newly published track or a
 * renamed category appears immediately — the owner changing something in the
 * admin and then reloading the site to check is the most common thing that will
 * ever happen here, and a stale cache would make it look broken.
 *
 * The three queries run concurrently; each is a single indexed read.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [copy, categories, featured, recent] = await Promise.all([
    getSiteCopy(),
    listCategories({ publishedOnly: true, withCounts: true }),
    listFeaturedAudio(6),
    listPublicAudio({ limit: 18, orderBy: 'recent' }),
  ]);

  const publicCategories = categories.map(toPublicCategory);
  const hasAnything = recent.length > 0 || publicCategories.length > 0;

  // A track that is already in "Featured" should not appear again eight rows
  // lower under "Recently added" — on a small library the two lists overlap
  // almost entirely, and the page reads as though it is repeating itself.
  const featuredIds = new Set(featured.map((track) => track.id));
  const recentlyAdded = recent.filter((track) => !featuredIds.has(track.id)).slice(0, 10);

  return (
    <div className="page">
      <section className="hero">
        <h1 className="hero__title">
          {copy.name}
          <span className="hero__accent">.</span>
        </h1>
        <p className="hero__tagline">{copy.tagline}</p>
        <div className="hero__search">
          <SearchBox />
        </div>
      </section>

      {!hasAnything ? (
        <div className="state">
          <span className="state__glyph" aria-hidden="true">
            ♫
          </span>
          <p className="state__title">The library is still being built</p>
          <p className="state__body">
            Nothing has been published yet. Check back shortly — there will be music here.
          </p>
        </div>
      ) : null}

      {publicCategories.length > 0 ? (
        <section className="section" aria-labelledby="categories-heading">
          <div className="section__head">
            <h2 className="section__title" id="categories-heading">
              Browse
            </h2>
          </div>
          <CategoryGrid categories={publicCategories} />
        </section>
      ) : null}

      {featured.length > 0 ? (
        <section className="section" aria-labelledby="featured-heading">
          <div className="section__head">
            <h2 className="section__title" id="featured-heading">
              Featured
            </h2>
          </div>
          <TrackList tracks={featured.map(toPublicAudio)} />
        </section>
      ) : null}

      {recentlyAdded.length > 0 ? (
        <section className="section" aria-labelledby="recent-heading">
          <div className="section__head">
            <h2 className="section__title" id="recent-heading">
              Recently added
            </h2>
            <Link href="/search" className="section__link">
              Browse everything →
            </Link>
          </div>
          <TrackList tracks={recentlyAdded.map(toPublicAudio)} />
        </section>
      ) : null}
    </div>
  );
}
