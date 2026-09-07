import Link from 'next/link';

import type { PublicCategory } from '@/lib/serializers';

/**
 * Category cards.
 *
 * A server component: these are plain links with no interactive state, so
 * shipping JavaScript for them would be waste. The per-card accent colour is
 * passed as a custom property and consumed by the stylesheet's gradient, which
 * keeps the styling in CSS rather than in inline style objects.
 */
export function CategoryGrid({ categories }: { categories: readonly PublicCategory[] }) {
  if (categories.length === 0) return null;

  return (
    <ul className="categories">
      {categories.map((category, index) => (
        <li key={category.id}>
          <Link
            href={`/category/${category.slug}`}
            className="category-card enter"
            style={
              {
                '--card-accent': category.accent ?? undefined,
                animationDelay: `${Math.min(index, 10) * 30}ms`,
              } as React.CSSProperties
            }
          >
            {category.icon ? (
              <span className="category-card__icon" aria-hidden="true">
                {category.icon}
              </span>
            ) : (
              <span className="category-card__icon" aria-hidden="true" />
            )}
            <span className="category-card__name">{category.name}</span>
            <span className="category-card__count">
              {category.audioCount} {category.audioCount === 1 ? 'track' : 'tracks'}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
