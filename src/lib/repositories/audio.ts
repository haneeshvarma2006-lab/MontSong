import 'server-only';

import { prisma } from '../db';
import { conflict, notFound } from '../errors';
import { createId, slugify, uniqueSlug } from '../ids';
import { logger } from '../logger';
import { buildSearchText } from './categories';
import type { AdminAudioQueryInput, UpdateAudioInput } from '../validation/schemas';

import type { Audio, Category, MediaFile, Prisma } from '@/generated/prisma';

/**
 * Track operations.
 *
 * Every write that changes a searchable field goes through `syncSearchText`,
 * so the denormalised haystack cannot drift from the row it describes.
 */

export type AudioWithRelations = Audio & {
  category: Category | null;
  media: MediaFile;
  cover: MediaFile | null;
  tags: { tag: { id: string; name: string; slug: string } }[];
};

const withRelations = {
  category: true,
  media: true,
  cover: true,
  tags: { include: { tag: true } },
} satisfies Prisma.AudioInclude;

const audioSlugExists = (excludeId?: string) => async (slug: string) => {
  const found = await prisma.audio.findUnique({ where: { slug }, select: { id: true } });
  return found !== null && found.id !== excludeId;
};

export async function getAudioBySlug(
  slug: string,
  options: { publishedOnly?: boolean } = {},
): Promise<AudioWithRelations | null> {
  const audio = await prisma.audio.findUnique({ where: { slug }, include: withRelations });
  if (!audio) return null;
  if (options.publishedOnly && !audio.isPublished) return null;
  return audio;
}

export async function getAudio(id: string): Promise<AudioWithRelations | null> {
  return prisma.audio.findUnique({ where: { id }, include: withRelations });
}

/**
 * Resolve the media row behind a public stream/download request.
 *
 * Unpublished tracks are indistinguishable from missing ones here: returning a
 * different error for "exists but hidden" would let anyone enumerate drafts.
 */
export async function getPlayableAudio(id: string): Promise<(Audio & { media: MediaFile }) | null> {
  const audio = await prisma.audio.findUnique({
    where: { id },
    include: { media: true },
  });
  if (!audio || !audio.isPublished) return null;
  return audio;
}

export async function listPublicAudio(options: {
  categoryId?: string;
  type?: string;
  limit?: number;
  orderBy?: 'recent' | 'popular' | 'order';
} = {}): Promise<AudioWithRelations[]> {
  const orderBy: Prisma.AudioOrderByWithRelationInput[] =
    options.orderBy === 'popular'
      ? [{ downloadCount: 'desc' }, { createdAt: 'desc' }]
      : options.orderBy === 'order'
        ? [{ sortOrder: 'asc' }, { createdAt: 'desc' }]
        : [{ createdAt: 'desc' }];

  return prisma.audio.findMany({
    where: {
      isPublished: true,
      ...(options.categoryId ? { categoryId: options.categoryId } : {}),
      ...(options.type ? { type: options.type } : {}),
    },
    orderBy,
    take: options.limit ?? 24,
    include: withRelations,
  });
}

export async function listFeaturedAudio(limit = 8): Promise<AudioWithRelations[]> {
  return prisma.audio.findMany({
    where: { isPublished: true, isFeatured: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    take: limit,
    include: withRelations,
  });
}

// --- Admin listing ----------------------------------------------------------

export interface AdminAudioPage {
  readonly items: AudioWithRelations[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly pageCount: number;
}

export async function listAudioForAdmin(query: AdminAudioQueryInput): Promise<AdminAudioPage> {
  const where: Prisma.AudioWhereInput = {
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.status === 'published'
      ? { isPublished: true }
      : query.status === 'unpublished'
        ? { isPublished: false }
        : {}),
    ...(query.q
      ? { searchText: { contains: query.q.toLowerCase() } }
      : {}),
  };

  const orderBy: Prisma.AudioOrderByWithRelationInput[] =
    query.sort === 'title'
      ? [{ title: 'asc' }]
      : query.sort === 'downloads'
        ? [{ downloadCount: 'desc' }, { createdAt: 'desc' }]
        : query.sort === 'order'
          ? [{ sortOrder: 'asc' }, { createdAt: 'desc' }]
          : [{ createdAt: 'desc' }];

  const [total, items] = await Promise.all([
    prisma.audio.count({ where }),
    prisma.audio.findMany({
      where,
      orderBy,
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
      include: withRelations,
    }),
  ]);

  return {
    items,
    total,
    page: query.page,
    perPage: query.perPage,
    pageCount: Math.max(1, Math.ceil(total / query.perPage)),
  };
}

// --- Mutations --------------------------------------------------------------

export interface CreateAudioInput {
  readonly title: string;
  readonly slug?: string;
  readonly artist?: string;
  readonly type: string;
  readonly description?: string;
  readonly categoryId?: string | null;
  readonly tags?: readonly string[];
  readonly isPublished: boolean;
  readonly isFeatured: boolean;
  readonly mediaId: string;
  readonly coverMediaId?: string | null;
}

/**
 * Create a track row for an already-stored media file.
 *
 * Runs inside a transaction with tag creation so a failure cannot leave a
 * track whose tags were only half attached.
 */
export async function createAudio(input: CreateAudioInput): Promise<AudioWithRelations> {
  const slug = input.slug
    ? await assertAudioSlugFree(input.slug)
    : await uniqueSlug(input.title, audioSlugExists(), 'track');

  if (input.categoryId) await assertCategoryExists(input.categoryId);

  const last = await prisma.audio.findFirst({
    where: { categoryId: input.categoryId ?? null },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });

  const categoryName = input.categoryId
    ? ((await prisma.category.findUnique({
        where: { id: input.categoryId },
        select: { name: true },
      })) ?? null)?.name ?? null
    : null;

  const id = createId();
  const tagNames = normaliseTags(input.tags);

  await prisma.$transaction(async (tx) => {
    await tx.audio.create({
      data: {
        id,
        title: input.title,
        slug,
        artist: input.artist ?? null,
        type: input.type,
        description: input.description ?? null,
        categoryId: input.categoryId ?? null,
        mediaId: input.mediaId,
        coverMediaId: input.coverMediaId ?? null,
        isPublished: input.isPublished,
        isFeatured: input.isFeatured,
        publishedAt: input.isPublished ? new Date() : null,
        sortOrder: (last?.sortOrder ?? 0) + 1,
        searchText: buildSearchText({
          title: input.title,
          artist: input.artist,
          categoryName,
          tags: tagNames,
        }),
      },
    });

    await attachTags(tx, id, tagNames);
  });

  const created = await getAudio(id);
  if (!created) throw notFound('The track could not be read back after creation.');
  return created;
}

export async function updateAudio(id: string, input: UpdateAudioInput): Promise<AudioWithRelations> {
  const existing = await prisma.audio.findUnique({
    where: { id },
    include: { tags: { include: { tag: true } } },
  });
  if (!existing) throw notFound('That track no longer exists.');

  const slug =
    input.slug !== undefined && input.slug !== existing.slug
      ? await assertAudioSlugFree(input.slug, id)
      : undefined;

  if (input.categoryId) await assertCategoryExists(input.categoryId);

  const tagNames = input.tags !== undefined ? normaliseTags(input.tags) : undefined;

  await prisma.$transaction(async (tx) => {
    await tx.audio.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(input.artist !== undefined ? { artist: input.artist ?? null } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId ?? null } : {}),
        ...(input.isFeatured !== undefined ? { isFeatured: input.isFeatured } : {}),
        ...(input.isPublished !== undefined
          ? {
              isPublished: input.isPublished,
              // Stamp the first publication only; re-publishing keeps the
              // original date so ordering by it stays stable.
              publishedAt:
                input.isPublished && existing.publishedAt === null ? new Date() : existing.publishedAt,
            }
          : {}),
      },
    });

    if (tagNames !== undefined) {
      await tx.tagOnAudio.deleteMany({ where: { audioId: id } });
      await attachTags(tx, id, tagNames);
    }
  });

  await syncSearchText(id);

  const updated = await getAudio(id);
  if (!updated) throw notFound('That track no longer exists.');
  return updated;
}

export async function moveAudio(id: string, categoryId: string | null): Promise<AudioWithRelations> {
  if (categoryId) await assertCategoryExists(categoryId);

  const existing = await prisma.audio.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('That track no longer exists.');

  // Moving a track puts it at the end of its new category rather than
  // inheriting a position that belonged to a different list.
  const last = await prisma.audio.findFirst({
    where: { categoryId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });

  await prisma.audio.update({
    where: { id },
    data: { categoryId, sortOrder: (last?.sortOrder ?? 0) + 1 },
  });

  await syncSearchText(id);

  const moved = await getAudio(id);
  if (!moved) throw notFound('That track no longer exists.');
  return moved;
}

export async function reorderAudio(orderedIds: readonly string[]): Promise<void> {
  const known = await prisma.audio.findMany({
    where: { id: { in: [...orderedIds] } },
    select: { id: true },
  });
  if (known.length !== orderedIds.length) {
    throw notFound('One of those tracks no longer exists. Reload and try again.');
  }

  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.audio.update({ where: { id }, data: { sortOrder: index + 1 } }),
    ),
  );
}

export async function setPublished(id: string, isPublished: boolean): Promise<AudioWithRelations> {
  const existing = await prisma.audio.findUnique({ where: { id } });
  if (!existing) throw notFound('That track no longer exists.');

  await prisma.audio.update({
    where: { id },
    data: {
      isPublished,
      publishedAt: isPublished && existing.publishedAt === null ? new Date() : existing.publishedAt,
    },
  });

  const updated = await getAudio(id);
  if (!updated) throw notFound('That track no longer exists.');
  return updated;
}

/**
 * Delete a track and, unless it is shared, the media rows behind it.
 *
 * Returns the media rows whose Telegram messages should now be removed; the
 * caller does that outside the transaction, because a slow or failing Telegram
 * call must not hold a database write open or roll back a completed delete.
 */
export async function deleteAudio(id: string): Promise<{ orphanedMedia: MediaFile[] }> {
  const audio = await prisma.audio.findUnique({
    where: { id },
    include: { media: true, cover: true },
  });
  if (!audio) throw notFound('That track no longer exists.');

  const orphaned: MediaFile[] = [];

  await prisma.$transaction(async (tx) => {
    await tx.audio.delete({ where: { id } });

    // The audio file belongs to exactly one track by construction, but check
    // rather than assume — a future re-upload flow could share one.
    const audioUsers = await tx.audio.count({ where: { mediaId: audio.mediaId } });
    if (audioUsers === 0) {
      orphaned.push(audio.media);
      await tx.mediaFile.delete({ where: { id: audio.mediaId } });
    }

    if (audio.cover) {
      const [coverUsers, categoryUsers] = await Promise.all([
        tx.audio.count({ where: { coverMediaId: audio.cover.id } }),
        tx.category.count({ where: { coverMediaId: audio.cover.id } }),
      ]);
      if (coverUsers === 0 && categoryUsers === 0) {
        orphaned.push(audio.cover);
        await tx.mediaFile.delete({ where: { id: audio.cover.id } });
      }
    }
  });

  return { orphanedMedia: orphaned };
}

// --- Helpers ----------------------------------------------------------------

async function assertAudioSlugFree(slug: string, excludeId?: string): Promise<string> {
  if (await audioSlugExists(excludeId)(slug)) {
    throw conflict(`The address "/song/${slug}" is already taken.`);
  }
  return slug;
}

async function assertCategoryExists(categoryId: string): Promise<void> {
  const found = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
  if (!found) throw notFound('That category no longer exists.');
}

function normaliseTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Map<string, string>();
  for (const raw of tags) {
    const name = raw.trim().slice(0, 40);
    if (!name) continue;
    const slug = slugify(name);
    if (!slug) continue;
    if (!seen.has(slug)) seen.set(slug, name);
  }
  return [...seen.values()];
}

async function attachTags(
  tx: Prisma.TransactionClient,
  audioId: string,
  tagNames: readonly string[],
): Promise<void> {
  for (const name of tagNames) {
    const slug = slugify(name);
    if (!slug) continue;

    const tag = await tx.tag.upsert({
      where: { slug },
      create: { id: createId(), name, slug },
      update: {},
    });

    await tx.tagOnAudio.upsert({
      where: { audioId_tagId: { audioId, tagId: tag.id } },
      create: { audioId, tagId: tag.id },
      update: {},
    });
  }
}

/** Recompute the denormalised haystack from the row's current relations. */
export async function syncSearchText(id: string): Promise<void> {
  const audio = await prisma.audio.findUnique({
    where: { id },
    select: {
      title: true,
      artist: true,
      category: { select: { name: true } },
      tags: { select: { tag: { select: { name: true } } } },
    },
  });
  if (!audio) return;

  await prisma.audio.update({
    where: { id },
    data: {
      searchText: buildSearchText({
        title: audio.title,
        artist: audio.artist,
        categoryName: audio.category?.name ?? null,
        tags: audio.tags.map((t) => t.tag.name),
      }),
    },
  });
}

/**
 * Record a download and bump the counter.
 *
 * Deliberately fire-and-forget at the call site: analytics must never delay or
 * fail a file transfer.
 */
export async function recordDownload(audioId: string, kind: 'download' | 'stream'): Promise<void> {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);

  try {
    await prisma.$transaction([
      prisma.downloadEvent.create({
        data: { id: createId(), audioId, kind, day, createdAt: now },
      }),
      prisma.audio.update({
        where: { id: audioId },
        data: kind === 'download' ? { downloadCount: { increment: 1 } } : { playCount: { increment: 1 } },
      }),
    ]);
  } catch (error) {
    logger.warn('analytics.record_failed', { audioId, kind, reason: String(error) });
  }
}
