import type { AudioType } from './constants';

import type { Audio, Category, MediaFile } from '@/generated/prisma';

/**
 * Wire shapes for everything that leaves the server.
 *
 * These types are the contract that keeps Telegram invisible. A `MediaFile` row
 * carries `telegramChatId`, `telegramFileId`, `telegramMessageId` and a
 * resolved `telegramFilePath`; none of those fields exist on any type below, so
 * a route that returns a serialised object cannot leak them by accident — and a
 * route that tried to return a raw row would fail typecheck.
 *
 * The only thing a client ever learns about a file is its own URL on this
 * origin, plus the descriptive metadata a music player needs.
 */

export interface PublicCategory {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly icon: string | null;
  readonly accent: string | null;
  readonly isFeatured: boolean;
  readonly audioCount: number;
  readonly coverUrl: string | null;
}

export interface PublicAudio {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly artist: string | null;
  readonly type: AudioType | string;
  readonly description: string | null;
  readonly durationSec: number | null;
  readonly fileSize: number;
  readonly format: string;
  readonly downloadCount: number;
  readonly isFeatured: boolean;
  readonly createdAt: string;
  readonly category: { id: string; name: string; slug: string } | null;
  readonly tags: readonly string[];
  readonly coverUrl: string | null;
  /** Same-origin endpoints. The only handles a client is ever given. */
  readonly streamUrl: string;
  readonly downloadUrl: string;
}

type AudioRow = Audio & {
  category?: Category | null;
  media: MediaFile;
  cover?: MediaFile | null;
  tags?: { tag: { name: string } }[];
};

/** Turn a mime type into something worth showing a person: "MP3", "FLAC". */
export function formatLabel(mimeType: string): string {
  switch (mimeType) {
    case 'audio/mpeg':
      return 'MP3';
    case 'audio/mp4':
      return 'M4A';
    case 'audio/aac':
      return 'AAC';
    case 'audio/ogg':
      return 'OGG';
    case 'audio/opus':
      return 'Opus';
    case 'audio/wav':
      return 'WAV';
    case 'audio/flac':
      return 'FLAC';
    default:
      return mimeType.split('/')[1]?.toUpperCase() ?? 'Audio';
  }
}

export function toPublicAudio(row: AudioRow): PublicAudio {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    artist: row.artist,
    type: row.type,
    description: row.description,
    durationSec: row.media.durationSec,
    fileSize: row.media.fileSize,
    format: formatLabel(row.media.mimeType),
    downloadCount: row.downloadCount,
    isFeatured: row.isFeatured,
    createdAt: row.createdAt.toISOString(),
    category: row.category
      ? { id: row.category.id, name: row.category.name, slug: row.category.slug }
      : null,
    tags: row.tags?.map((entry) => entry.tag.name) ?? [],
    coverUrl: row.coverMediaId ? `/api/audio/${row.id}/cover` : null,
    streamUrl: `/api/audio/${row.id}/stream`,
    downloadUrl: `/api/audio/${row.id}/download`,
  };
}

export function toPublicCategory(
  row: Category & { audioCount?: number },
): PublicCategory {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    icon: row.icon,
    accent: row.accent,
    isFeatured: row.isFeatured,
    audioCount: row.audioCount ?? 0,
    coverUrl: row.coverMediaId ? `/api/categories/${row.id}/cover` : null,
  };
}

// --- Admin shapes -----------------------------------------------------------

/**
 * What the admin UI sees. Richer than the public shape — publication state,
 * play counts, the stored filename — but still free of Telegram identifiers:
 * there is no reason for the browser to hold them even behind a login, and
 * keeping them server-side means an XSS in the admin cannot exfiltrate the
 * storage layout.
 */
export interface AdminAudio extends PublicAudio {
  readonly isPublished: boolean;
  readonly playCount: number;
  readonly sortOrder: number;
  readonly updatedAt: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly categoryId: string | null;
}

export function toAdminAudio(row: AudioRow): AdminAudio {
  return {
    ...toPublicAudio(row),
    isPublished: row.isPublished,
    playCount: row.playCount,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
    fileName: row.media.fileName,
    mimeType: row.media.mimeType,
    categoryId: row.categoryId,
  };
}

export interface AdminCategory extends PublicCategory {
  readonly isPublished: boolean;
  readonly sortOrder: number;
  readonly createdAt: string;
}

export function toAdminCategory(row: Category & { audioCount?: number }): AdminCategory {
  return {
    ...toPublicCategory(row),
    isPublished: row.isPublished,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}
