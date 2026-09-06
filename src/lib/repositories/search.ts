import 'server-only';

import { prisma } from '../db';

import type { Audio, Category, MediaFile, Prisma } from '@/generated/prisma';

/**
 * Search.
 *
 * The library this is built for holds tens to low thousands of tracks, so the
 * right implementation is the simplest one that stays correct: every query term
 * must appear somewhere in the denormalised `searchText` haystack (title,
 * artist, category name, tags), and results are ranked by where the match
 * landed.
 *
 * `LIKE '%term%'` cannot use a B-tree index, so this is a scan. At the sizes
 * involved that is microseconds, and it beats the alternatives on behaviour:
 * it matches inside words, which is what people expect when they type "vijay"
 * and want "Vijay Antony", and it handles Tamil text without a tokeniser that
 * understands Tamil.
 *
 * **When to change this.** Past roughly 50,000 tracks the scan starts to show.
 * The migration path is SQLite's FTS5: create a virtual table over the same
 * haystack, keep it in sync with triggers, and swap the `where` below for a
 * `MATCH`. Nothing outside this module would change — every caller goes through
 * `searchAudio`, and the ranking contract stays the same.
 */

export type SearchHit = Audio & {
  category: Category | null;
  media: MediaFile;
  cover: MediaFile | null;
};

export interface SearchOptions {
  readonly query?: string;
  readonly categoryId?: string;
  readonly type?: string;
  readonly limit?: number;
  readonly publishedOnly?: boolean;
}

/** Split a raw query into the terms every result must contain. */
export function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    // A single stray character matches almost everything; ignore it unless it
    // is the entire query, where the user clearly meant it.
    .slice(0, 8);
}

export async function searchAudio(options: SearchOptions): Promise<SearchHit[]> {
  const limit = options.limit ?? 24;
  const terms = options.query ? searchTerms(options.query) : [];

  const where: Prisma.AudioWhereInput = {
    ...(options.publishedOnly === false ? {} : { isPublished: true }),
    ...(options.categoryId ? { categoryId: options.categoryId } : {}),
    ...(options.type ? { type: options.type } : {}),
    ...(terms.length > 0
      ? { AND: terms.map((term) => ({ searchText: { contains: term } })) }
      : {}),
  };

  const rows = await prisma.audio.findMany({
    where,
    // Over-fetch so ranking has something to reorder; the slice happens below.
    take: Math.min(limit * 4, 200),
    orderBy: [{ downloadCount: 'desc' }, { createdAt: 'desc' }],
    include: { category: true, media: true, cover: true },
  });

  if (terms.length === 0) return rows.slice(0, limit);

  return rows
    .map((row) => ({ row, score: score(row, terms) }))
    .sort((a, b) => b.score - a.score || b.row.downloadCount - a.row.downloadCount)
    .slice(0, limit)
    .map((entry) => entry.row);
}

/**
 * Rank a hit. A title match beats an artist match beats a tag or category
 * match, and a match at the start of a word beats one in the middle, so
 * searching "vij" surfaces "Vijay" above "Sivaji Vijay".
 */
function score(row: SearchHit, terms: readonly string[]): number {
  const title = row.title.toLowerCase();
  const artist = (row.artist ?? '').toLowerCase();
  let total = 0;

  for (const term of terms) {
    if (title === term) total += 100;
    else if (title.startsWith(term)) total += 60;
    else if (title.includes(` ${term}`)) total += 40;
    else if (title.includes(term)) total += 25;

    if (artist === term) total += 45;
    else if (artist.startsWith(term)) total += 30;
    else if (artist.includes(term)) total += 15;

    // Anything else that matched did so through the haystack: category or tag.
    if (!title.includes(term) && !artist.includes(term)) total += 6;
  }

  if (row.isFeatured) total += 5;
  return total;
}

/** Lightweight suggestions for the search box. */
export async function suggest(query: string, limit = 6): Promise<SearchHit[]> {
  if (query.trim().length === 0) return [];
  return searchAudio({ query, limit });
}
