import { describe, expect, it } from 'vitest';

import { formatLabel, toAdminAudio, toPublicAudio, toPublicCategory } from '@/lib/serializers';
import { slugify, uniqueSlug, createId } from '@/lib/ids';
import { buildSearchText } from '@/lib/repositories/categories';
import { searchTerms } from '@/lib/repositories/search';

import type { Audio, Category, MediaFile } from '@/generated/prisma';

/**
 * The most important assertion in the suite: nothing Telegram-shaped ever
 * reaches a serialised object.
 *
 * The `MediaFile` row deliberately carries every Telegram coordinate; the
 * serialisers are the wall between that row and the wire, so a leak here is a
 * leak everywhere.
 */

const media: MediaFile = {
  id: 'media-1',
  kind: 'audio',
  telegramChatId: '-1001234567890',
  telegramMessageId: 4242,
  telegramFileId: 'BAADBAADrwADBREAAYag3N4A_SECRET',
  telegramFileUniqueId: 'AgADrwADBREAAQ',
  mimeType: 'audio/mpeg',
  fileName: 'original upload name.mp3',
  fileSize: 3_500_000,
  durationSec: 214,
  width: null,
  height: null,
  sha256: 'abc123',
  telegramFilePath: 'music/file_9.mp3',
  telegramFilePathFetchedAt: new Date('2026-01-01T00:00:00Z'),
  status: 'stored',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const category: Category = {
  id: 'cat-1',
  name: 'Tamil OGs',
  slug: 'tamil-ogs',
  description: 'The originals.',
  icon: '🔥',
  accent: '#e0523f',
  coverMediaId: null,
  sortOrder: 1,
  isPublished: true,
  isFeatured: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const audio: Audio & { category: Category | null; media: MediaFile; cover: MediaFile | null } = {
  id: 'audio-1',
  title: 'A Song',
  slug: 'a-song',
  artist: 'An Artist',
  type: 'song',
  description: null,
  categoryId: 'cat-1',
  mediaId: 'media-1',
  coverMediaId: null,
  downloadCount: 12,
  playCount: 40,
  sortOrder: 1,
  isPublished: true,
  isFeatured: false,
  publishedAt: new Date('2026-01-01T00:00:00Z'),
  searchText: ' a song an artist tamil ogs ',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  category,
  media,
  cover: null,
};

const SECRETS = [
  media.telegramChatId,
  String(media.telegramMessageId),
  media.telegramFileId,
  media.telegramFileUniqueId,
  media.telegramFilePath,
  'api.telegram.org',
  'telegram',
];

describe('serialisers keep Telegram invisible', () => {
  it('leaks nothing through the public track shape', () => {
    const serialised = JSON.stringify(toPublicAudio(audio)).toLowerCase();
    for (const secret of SECRETS) {
      expect(serialised).not.toContain(String(secret).toLowerCase());
    }
  });

  it('leaks nothing through the admin track shape either', () => {
    // The admin is authenticated, but there is still no reason for storage
    // coordinates to be in a browser — an XSS there would exfiltrate them.
    const serialised = JSON.stringify(toAdminAudio(audio)).toLowerCase();
    for (const secret of SECRETS) {
      expect(serialised).not.toContain(String(secret).toLowerCase());
    }
  });

  it('hands the client only same-origin URLs', () => {
    const track = toPublicAudio(audio);
    expect(track.streamUrl).toBe('/api/audio/audio-1/stream');
    expect(track.downloadUrl).toBe('/api/audio/audio-1/download');
    expect(track.streamUrl.startsWith('/')).toBe(true);
    expect(track.downloadUrl.startsWith('/')).toBe(true);
  });

  it('exposes the descriptive metadata a player needs', () => {
    const track = toPublicAudio(audio);
    expect(track).toMatchObject({
      title: 'A Song',
      artist: 'An Artist',
      durationSec: 214,
      fileSize: 3_500_000,
      format: 'MP3',
      downloadCount: 12,
      category: { id: 'cat-1', name: 'Tamil OGs', slug: 'tamil-ogs' },
    });
  });

  it('offers a cover URL only when there is a cover', () => {
    expect(toPublicAudio(audio).coverUrl).toBeNull();
    expect(toPublicAudio({ ...audio, coverMediaId: 'media-2' }).coverUrl).toBe(
      '/api/audio/audio-1/cover',
    );
  });

  it('does not expose the original upload filename publicly', () => {
    // It can carry information about the owner's own filesystem.
    expect(JSON.stringify(toPublicAudio(audio))).not.toContain('original upload name');
  });

  it('serialises a category without its storage coordinates', () => {
    const serialised = JSON.stringify(toPublicCategory({ ...category, audioCount: 5 }));
    expect(serialised).not.toContain('telegram');
    expect(JSON.parse(serialised)).toMatchObject({ name: 'Tamil OGs', audioCount: 5 });
  });
});

describe('formatLabel', () => {
  it('turns mime types into something worth reading', () => {
    expect(formatLabel('audio/mpeg')).toBe('MP3');
    expect(formatLabel('audio/mp4')).toBe('M4A');
    expect(formatLabel('audio/flac')).toBe('FLAC');
    expect(formatLabel('audio/unknown-thing')).toBe('UNKNOWN-THING');
  });
});

describe('slugify', () => {
  it('produces clean URL segments', () => {
    expect(slugify('Tamil OGs')).toBe('tamil-ogs');
    expect(slugify('  Mass   Songs!  ')).toBe('mass-songs');
    expect(slugify("Vijay's Best")).toBe('vijays-best');
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
    expect(slugify('a---b')).toBe('a-b');
  });

  it('returns an empty string for text with no ASCII, which callers must handle', () => {
    expect(slugify('தமிழ்')).toBe('');
    expect(slugify('!!!')).toBe('');
  });

  it('caps the length without leaving a trailing hyphen', () => {
    const slug = slugify(`${'word '.repeat(40)}`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('uniqueSlug', () => {
  it('returns the base slug when it is free', async () => {
    await expect(uniqueSlug('Tamil OGs', async () => false)).resolves.toBe('tamil-ogs');
  });

  it('appends a counter on collision', async () => {
    const taken = new Set(['tamil-ogs', 'tamil-ogs-2']);
    await expect(uniqueSlug('Tamil OGs', async (slug) => taken.has(slug))).resolves.toBe(
      'tamil-ogs-3',
    );
  });

  it('invents a slug when the title has no ASCII at all', async () => {
    const slug = await uniqueSlug('தமிழ் பாடல்', async () => false, 'track');
    expect(slug).toMatch(/^track-[0-9a-f]{6}$/);
  });

  it('terminates even when everything collides', async () => {
    const slug = await uniqueSlug('busy', async () => true);
    expect(slug.startsWith('busy-')).toBe(true);
  });
});

describe('createId', () => {
  it('produces unique, sortable, URL-safe ids', () => {
    const ids = Array.from({ length: 500 }, () => createId());
    expect(new Set(ids).size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{24}$/);
    // Generated in the same millisecond or later, so lexical order tracks time.
    expect([...ids].sort()[0]?.slice(0, 8)).toBe(ids[0]?.slice(0, 8));
  });
});

describe('buildSearchText', () => {
  it('folds every searchable field into one lowercase haystack', () => {
    const text = buildSearchText({
      title: 'Vaathi Coming',
      artist: 'Anirudh',
      categoryName: 'Mass Songs',
      tags: ['Vijay', '2020s'],
    });

    expect(text).toBe(' vaathi coming anirudh mass songs vijay 2020s ');
    expect(text.startsWith(' ')).toBe(true);
    expect(text.endsWith(' ')).toBe(true);
  });

  it('skips absent fields without leaving double spaces', () => {
    expect(buildSearchText({ title: 'Solo' })).toBe(' solo ');
  });
});

describe('searchTerms', () => {
  it('splits and trims', () => {
    expect(searchTerms('  Vijay   Antony ')).toEqual(['vijay', 'antony']);
  });

  it('caps the number of terms so one query cannot build a huge AND', () => {
    expect(searchTerms(Array.from({ length: 40 }, (_, i) => `t${i}`).join(' '))).toHaveLength(8);
  });

  it('returns nothing for whitespace', () => {
    expect(searchTerms('    ')).toEqual([]);
  });
});
