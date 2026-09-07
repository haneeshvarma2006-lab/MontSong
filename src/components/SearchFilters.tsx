'use client';

import Link from 'next/link';

import { AUDIO_TYPE_LABELS, type AudioType } from '@/lib/constants';
import type { PublicCategory } from '@/lib/serializers';

/**
 * Filter chips.
 *
 * Plain links rather than buttons with client state: each filter is a real URL,
 * so it can be shared, bookmarked and reached with the back button, and the
 * results underneath are the server's answer rather than something reconstructed
 * in the browser.
 */
export function SearchFilters({
  categories,
  types,
  activeCategory,
  activeType,
  query,
}: {
  categories: readonly PublicCategory[];
  types: readonly AudioType[];
  activeCategory?: string;
  activeType?: AudioType;
  query: string;
}) {
  const href = (patch: { category?: string; type?: string }) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);

    const category = 'category' in patch ? patch.category : activeCategory;
    const type = 'type' in patch ? patch.type : activeType;
    if (category) params.set('category', category);
    if (type) params.set('type', type);

    const search = params.toString();
    return search ? `/search?${search}` : '/search';
  };

  if (categories.length === 0) return null;

  return (
    <div className="stack">
      <div className="filters" role="group" aria-label="Filter by category">
        <Link
          href={href({ category: undefined })}
          className="filters__chip"
          data-active={!activeCategory}
        >
          All
        </Link>
        {categories.map((category) => (
          <Link
            key={category.id}
            href={href({ category: category.slug })}
            className="filters__chip"
            data-active={activeCategory === category.slug}
          >
            {category.icon ? <span aria-hidden="true">{category.icon} </span> : null}
            {category.name}
          </Link>
        ))}
      </div>

      <div className="filters" role="group" aria-label="Filter by kind">
        <Link href={href({ type: undefined })} className="filters__chip" data-active={!activeType}>
          Any kind
        </Link>
        {types.map((type) => (
          <Link
            key={type}
            href={href({ type })}
            className="filters__chip"
            data-active={activeType === type}
          >
            {AUDIO_TYPE_LABELS[type]}
          </Link>
        ))}
      </div>
    </div>
  );
}
