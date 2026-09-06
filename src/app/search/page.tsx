import type { Metadata } from 'next';

import { SearchBox } from '@/components/SearchBox';
import { SearchFilters } from '@/components/SearchFilters';
import { TrackList } from '@/components/TrackList';
import { listCategories } from '@/lib/repositories/categories';
import { searchAudio } from '@/lib/repositories/search';
import { toPublicAudio, toPublicCategory } from '@/lib/serializers';
import { AUDIO_TYPES, isAudioType } from '@/lib/constants';

/**
 * The full search page.
 *
 * Results are rendered on the server from the URL's own query, so a search is
 * shareable, survives a reload, and works before any JavaScript has loaded.
 * The live suggestion dropdown in the header is a convenience layered on top of
 * this, not a replacement for it.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search the library by title, artist, category or tag.',
  // A search results page is not something to have indexed.
  robots: { index: false, follow: true },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawQuery = typeof params.q === 'string' ? params.q.slice(0, 120) : '';
  const rawCategory = typeof params.category === 'string' ? params.category : undefined;
  const rawType = typeof params.type === 'string' ? params.type : undefined;
  const type = isAudioType(rawType) ? rawType : undefined;

  const categories = await listCategories({ publishedOnly: true, withCounts: true });
  const category = rawCategory ? categories.find((item) => item.slug === rawCategory) : undefined;

  const results = await searchAudio({
    query: rawQuery || undefined,
    categoryId: category?.id,
    type,
    limit: 60,
    publishedOnly: true,
  });

  const hasFilters = Boolean(rawQuery || category || type);

  return (
    <div className="page">
      <section className="hero" style={{ paddingBottom: 'var(--s-6)' }}>
        <h1 className="hero__title" style={{ fontSize: 'var(--text-2xl)' }}>
          Search
        </h1>
        <div className="hero__search" style={{ marginTop: 'var(--s-6)' }}>
          <SearchBox autoFocus />
        </div>
      </section>

      <SearchFilters
        categories={categories.map(toPublicCategory)}
        types={[...AUDIO_TYPES]}
        activeCategory={rawCategory}
        activeType={type}
        query={rawQuery}
      />

      <div className="section" style={{ marginTop: 'var(--s-8)' }}>
        <p className="section__head" style={{ marginBottom: 'var(--s-3)' }}>
          <span className="section__title" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-faint)', fontWeight: 500 }}>
            {results.length === 0
              ? 'No results'
              : `${results.length} ${results.length === 1 ? 'result' : 'results'}`}
            {rawQuery ? ` for “${rawQuery}”` : ''}
          </span>
        </p>

        <TrackList
          tracks={results.map(toPublicAudio)}
          emptyTitle={hasFilters ? 'Nothing matched' : 'Start typing to search'}
          emptyBody={
            hasFilters
              ? 'Try a shorter search, a different spelling, or clear the filters.'
              : 'Search by song title, artist, category or tag.'
          }
        />
      </div>
    </div>
  );
}
