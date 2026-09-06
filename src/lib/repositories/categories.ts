import 'server-only';

import { prisma } from '../db';
import { conflict, notFound } from '../errors';
import { createId, uniqueSlug } from '../ids';
import type { CreateCategoryInput, UpdateCategoryInput } from '../validation/schemas';

import type { Category, Prisma } from '@/generated/prisma';

/**
 * Category operations.
 *
 * Categories are entirely owner-defined — nothing in the codebase names a
 * category, and the public site renders whatever rows exist. That is the
 * requirement that shapes this module: create, rename, reorder and delete all
 * have to be safe to run against a live library.
 */

export interface CategoryWithCount extends Category {
  readonly audioCount: number;
}

const slugExists = (excludeId?: string) => async (slug: string) => {
  const found = await prisma.category.findUnique({ where: { slug }, select: { id: true } });
  return found !== null && found.id !== excludeId;
};

export async function listCategories(options: {
  publishedOnly?: boolean;
  withCounts?: boolean;
} = {}): Promise<CategoryWithCount[]> {
  const where: Prisma.CategoryWhereInput = options.publishedOnly ? { isPublished: true } : {};

  const rows = await prisma.category.findMany({
    where,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      _count: {
        select: {
          // A category's public count must not include hidden tracks, or the
          // card promises songs the visitor cannot see.
          audios: options.publishedOnly ? { where: { isPublished: true } } : true,
        },
      },
    },
  });

  return rows.map(({ _count, ...category }) => ({ ...category, audioCount: _count.audios }));
}

export async function getCategoryBySlug(
  slug: string,
  options: { publishedOnly?: boolean } = {},
): Promise<Category | null> {
  const category = await prisma.category.findUnique({ where: { slug } });
  if (!category) return null;
  if (options.publishedOnly && !category.isPublished) return null;
  return category;
}

export async function getCategory(id: string): Promise<Category | null> {
  return prisma.category.findUnique({ where: { id } });
}

export async function createCategory(input: CreateCategoryInput): Promise<Category> {
  const slug = input.slug
    ? await assertSlugFree(input.slug)
    : await uniqueSlug(input.name, slugExists(), 'category');

  // New categories go to the end of the list rather than the front, so adding
  // one never reshuffles what visitors are used to seeing.
  const last = await prisma.category.findFirst({
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });

  return prisma.category.create({
    data: {
      id: createId(),
      name: input.name,
      slug,
      description: input.description ?? null,
      icon: input.icon ?? null,
      accent: input.accent ?? null,
      isPublished: input.isPublished,
      isFeatured: input.isFeatured,
      sortOrder: (last?.sortOrder ?? 0) + 1,
    },
  });
}

export async function updateCategory(id: string, input: UpdateCategoryInput): Promise<Category> {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) throw notFound('That category no longer exists.');

  const slug =
    input.slug !== undefined && input.slug !== existing.slug
      ? await assertSlugFree(input.slug, id)
      : undefined;

  const updated = await prisma.category.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(slug !== undefined ? { slug } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.icon !== undefined ? { icon: input.icon ?? null } : {}),
      ...(input.accent !== undefined ? { accent: input.accent ?? null } : {}),
      ...(input.isPublished !== undefined ? { isPublished: input.isPublished } : {}),
      ...(input.isFeatured !== undefined ? { isFeatured: input.isFeatured } : {}),
    },
  });

  // The category name is part of every member track's search haystack.
  if (input.name !== undefined && input.name !== existing.name) {
    await refreshSearchTextForCategory(id);
  }

  return updated;
}

/**
 * Persist a new order.
 *
 * Written as one transaction so a half-applied reorder cannot leave two
 * categories claiming the same position. Ids not present in the list keep
 * their relative order after the ones that were.
 */
export async function reorderCategories(orderedIds: readonly string[]): Promise<void> {
  const known = await prisma.category.findMany({ select: { id: true } });
  const knownIds = new Set(known.map((row) => row.id));

  const unknown = orderedIds.filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    throw notFound('One of those categories no longer exists. Reload and try again.');
  }

  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.category.update({ where: { id }, data: { sortOrder: index + 1 } }),
    ),
  );
}

export type DeleteMode = 'unassign' | 'reassign';

/**
 * Delete a category without orphaning its tracks.
 *
 * The schema's `onDelete: SetNull` already guarantees no dangling reference,
 * but silently dropping a hundred songs into "uncategorised" is a nasty
 * surprise, so the caller has to say what should happen to them and gets told
 * how many were affected.
 */
export async function deleteCategory(
  id: string,
  options: { mode: DeleteMode; targetCategoryId?: string },
): Promise<{ movedAudio: number }> {
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) throw notFound('That category no longer exists.');

  if (options.mode === 'reassign') {
    if (!options.targetCategoryId) {
      throw conflict('Choose a category to move the tracks into.');
    }
    if (options.targetCategoryId === id) {
      throw conflict('Tracks cannot be moved into the category being deleted.');
    }
    const target = await prisma.category.findUnique({
      where: { id: options.targetCategoryId },
      select: { id: true },
    });
    if (!target) throw notFound('The destination category no longer exists.');
  }

  return prisma.$transaction(async (tx) => {
    const affected = await tx.audio.count({ where: { categoryId: id } });

    await tx.audio.updateMany({
      where: { categoryId: id },
      data: { categoryId: options.mode === 'reassign' ? options.targetCategoryId : null },
    });

    await tx.category.delete({ where: { id } });

    return { movedAudio: affected };
  });
}

async function assertSlugFree(slug: string, excludeId?: string): Promise<string> {
  if (await slugExists(excludeId)(slug)) {
    throw conflict(`The address "/category/${slug}" is already taken.`);
  }
  return slug;
}

/**
 * Rebuild the denormalised search text for every track in a category.
 * Called after a rename so search keeps matching the new name.
 */
export async function refreshSearchTextForCategory(categoryId: string): Promise<void> {
  const tracks = await prisma.audio.findMany({
    where: { categoryId },
    select: {
      id: true,
      title: true,
      artist: true,
      category: { select: { name: true } },
      tags: { select: { tag: { select: { name: true } } } },
    },
  });

  await prisma.$transaction(
    tracks.map((track) =>
      prisma.audio.update({
        where: { id: track.id },
        data: {
          searchText: buildSearchText({
            title: track.title,
            artist: track.artist,
            categoryName: track.category?.name ?? null,
            tags: track.tags.map((t) => t.tag.name),
          }),
        },
      }),
    ),
  );
}

/**
 * The haystack a search query is matched against.
 *
 * Lowercased and space-delimited, with a leading and trailing space so a
 * `LIKE '% term%'` can anchor to word starts when it wants to.
 */
export function buildSearchText(input: {
  title: string;
  artist?: string | null;
  categoryName?: string | null;
  tags?: readonly string[];
}): string {
  const parts = [input.title, input.artist ?? '', input.categoryName ?? '', ...(input.tags ?? [])];
  return ` ${parts.filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').trim()} `;
}
