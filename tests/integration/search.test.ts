import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as login } from '@/app/api/admin/auth/login/route';
import { POST as adminCreateCategory } from '@/app/api/admin/categories/route';
import { POST as upload } from '@/app/api/admin/audio/route';
import { PATCH as patchAudio } from '@/app/api/admin/audio/[id]/route';
import { PATCH as patchCategory } from '@/app/api/admin/categories/[id]/route';
import { GET as search } from '@/app/api/search/route';
import { resetAllRateLimits } from '@/lib/auth/rate-limit';
import { prisma } from '@/lib/db';
import type { AdminAudio, AdminCategory, PublicAudio } from '@/lib/serializers';

import { resetJar } from '../helpers/cookie-jar';
import { mp3Bytes, multipart } from '../helpers/fixtures';
import { FakeTelegram, installFakeTelegram } from '../helpers/telegram';
import { jsonRequest, makeRequest, params, readJson } from '../helpers/request';
import { TEST_ENV } from '../setup';

/**
 * Search.
 *
 * The behaviour that matters to a visitor: typing part of a title, an artist,
 * a category or a tag finds the track, the best match comes first, and nothing
 * unpublished ever appears.
 */

const telegram = new FakeTelegram();
let restoreFetch: () => void;
let masses: AdminCategory;
let ringtones: AdminCategory;

let counter = 0;

async function addTrack(metadata: Record<string, unknown>): Promise<AdminAudio> {
  counter += 1;
  const { body, contentType } = multipart({
    fields: { metadata: JSON.stringify(metadata) },
    files: [
      {
        field: 'audio',
        fileName: `search-${counter}.mp3`,
        contentType: 'audio/mpeg',
        // Distinct bytes so the duplicate check does not reject these.
        bytes: mp3Bytes(1000 + counter),
      },
    ],
  });

  const response = await upload(
    makeRequest('/api/admin/audio', {
      method: 'POST',
      body: new Uint8Array(body),
      headers: { 'content-type': contentType },
    }),
  );

  expect(response.status).toBe(201);
  return (await readJson<{ audio: AdminAudio }>(response)).audio;
}

async function query(queryString: string): Promise<PublicAudio[]> {
  const response = await search(makeRequest(`/api/search?${queryString}`));
  expect(response.status).toBe(200);
  return (await readJson<{ results: PublicAudio[] }>(response)).results;
}

async function makeCategory(name: string): Promise<AdminCategory> {
  const response = await adminCreateCategory(
    jsonRequest('/api/admin/categories', { method: 'POST', json: { name } }),
  );
  return (await readJson<{ category: AdminCategory }>(response)).category;
}

beforeAll(async () => {
  restoreFetch = installFakeTelegram(telegram);
  resetJar();
  resetAllRateLimits();

  await login(
    jsonRequest('/api/admin/auth/login', {
      method: 'POST',
      json: { username: TEST_ENV.username, password: TEST_ENV.password },
    }),
  );
});

afterAll(() => {
  restoreFetch();
});

beforeEach(async () => {
  resetAllRateLimits();
  telegram.reset();
  await prisma.audio.deleteMany({});
  await prisma.tagOnAudio.deleteMany({});
  await prisma.tag.deleteMany({});
  await prisma.mediaFile.deleteMany({});
  await prisma.uploadIntent.deleteMany({});
  await prisma.category.deleteMany({});

  masses = await makeCategory('Mass Songs');
  ringtones = await makeCategory('Ringtones');
});

describe('finding tracks', () => {
  beforeEach(async () => {
    await addTrack({
      title: 'Vaathi Coming',
      artist: 'Anirudh Ravichander',
      categoryId: masses.id,
      tags: ['vijay', 'master'],
      type: 'song',
    });
    await addTrack({
      title: 'Beast Mode',
      artist: 'Anirudh Ravichander',
      categoryId: masses.id,
      tags: ['vijay'],
      type: 'song',
    });
    await addTrack({
      title: 'Gentle Morning Tone',
      artist: 'Unknown',
      categoryId: ringtones.id,
      tags: ['soft'],
      type: 'ringtone',
    });
  });

  it('matches on title', async () => {
    const results = await query('q=vaathi');
    expect(results.map((track) => track.title)).toEqual(['Vaathi Coming']);
  });

  it('matches on artist — the example from the brief', async () => {
    const results = await query('q=anirudh');
    expect(results).toHaveLength(2);
    expect(results.every((track) => track.artist === 'Anirudh Ravichander')).toBe(true);
  });

  it('matches a partial word, because that is how people type', async () => {
    expect((await query('q=vij')).length).toBe(2);
    expect((await query('q=morn')).map((track) => track.title)).toEqual(['Gentle Morning Tone']);
  });

  it('matches on category name', async () => {
    const results = await query('q=ringtones');
    expect(results.map((track) => track.title)).toEqual(['Gentle Morning Tone']);
  });

  it('matches on tag', async () => {
    const results = await query('q=master');
    expect(results.map((track) => track.title)).toEqual(['Vaathi Coming']);
  });

  it('is case-insensitive', async () => {
    expect((await query('q=VAATHI')).length).toBe(1);
    expect((await query('q=VaAtHi')).length).toBe(1);
  });

  it('requires every term to match', async () => {
    expect((await query('q=vijay+vaathi')).map((track) => track.title)).toEqual(['Vaathi Coming']);
    expect(await query('q=vaathi+nonexistent')).toEqual([]);
  });

  it('ranks a title match above a match that only came through the haystack', async () => {
    await addTrack({
      title: 'Something Else',
      artist: 'Beast Fan',
      categoryId: masses.id,
      type: 'song',
    });

    const results = await query('q=beast');
    expect(results[0]?.title).toBe('Beast Mode');
  });

  it('returns nothing for a query that matches nothing', async () => {
    expect(await query('q=zzzzzzzz')).toEqual([]);
  });

  it('filters by category', async () => {
    const results = await query(`category=${ringtones.slug}`);
    expect(results.map((track) => track.title)).toEqual(['Gentle Morning Tone']);
  });

  it('filters by kind', async () => {
    expect((await query('type=ringtone')).map((track) => track.title)).toEqual([
      'Gentle Morning Tone',
    ]);
    expect((await query('type=song')).length).toBe(2);
  });

  it('combines a query with a filter', async () => {
    expect(await query(`q=vaathi&category=${ringtones.slug}`)).toEqual([]);
    expect((await query(`q=vaathi&category=${masses.slug}`)).length).toBe(1);
  });

  it('returns nothing rather than everything for an unknown category', async () => {
    // Returning the whole library would be a surprising, and wrong, fallback.
    expect(await query('category=no-such-category')).toEqual([]);
  });

  it('honours a limit', async () => {
    expect(await query('limit=1')).toHaveLength(1);
  });

  it('rejects an out-of-range limit rather than silently clamping', async () => {
    const response = await search(makeRequest('/api/search?limit=9999'));
    expect(response.status).toBe(422);
  });

  it('rejects an unknown query parameter', async () => {
    const response = await search(makeRequest('/api/search?q=x&sneaky=1'));
    expect(response.status).toBe(422);
  });

  it('treats a search containing SQL as ordinary text', async () => {
    // The ORM parameterises everything; this asserts the behaviour, not the
    // absence of a vulnerability in the abstract.
    const response = await search(
      makeRequest(`/api/search?q=${encodeURIComponent("'; DROP TABLE audio; --")}`),
    );

    expect(response.status).toBe(200);
    expect((await readJson<{ results: PublicAudio[] }>(response)).results).toEqual([]);
    expect(await prisma.audio.count()).toBe(3);
  });

  it('handles a Tamil-script query without error', async () => {
    await addTrack({ title: 'தமிழ் பாடல்', categoryId: masses.id, type: 'song' });
    const results = await query(`q=${encodeURIComponent('தமிழ்')}`);
    expect(results.map((track) => track.title)).toContain('தமிழ் பாடல்');
  });
});

describe('visibility', () => {
  it('never returns an unpublished track', async () => {
    const track = await addTrack({ title: 'Draft Only', categoryId: masses.id, type: 'song' });
    expect((await query('q=draft')).length).toBe(1);

    await patchAudio(
      makeRequest(`/api/admin/audio/${track.id}?action=publish&value=false`, { method: 'PATCH' }),
      params({ id: track.id }),
    );

    expect(await query('q=draft')).toEqual([]);
  });

  it('hides tracks in a hidden category from a category filter', async () => {
    await addTrack({ title: 'Hidden Home', categoryId: ringtones.id, type: 'ringtone' });

    await patchCategory(
      jsonRequest(`/api/admin/categories/${ringtones.id}`, {
        method: 'PATCH',
        json: { isPublished: false },
      }),
      params({ id: ringtones.id }),
    );

    expect(await query(`category=${ringtones.slug}`)).toEqual([]);
  });
});

describe('search keeps up with edits', () => {
  it('finds a track under its new title straight after a rename', async () => {
    const track = await addTrack({ title: 'Original Title', categoryId: masses.id, type: 'song' });

    await patchAudio(
      jsonRequest(`/api/admin/audio/${track.id}`, {
        method: 'PATCH',
        json: { title: 'Completely Different' },
      }),
      params({ id: track.id }),
    );

    expect((await query('q=completely')).length).toBe(1);
    expect(await query('q=original')).toEqual([]);
  });

  it('finds tracks by a renamed category', async () => {
    await addTrack({ title: 'Category Member', categoryId: masses.id, type: 'song' });

    await patchCategory(
      jsonRequest(`/api/admin/categories/${masses.id}`, {
        method: 'PATCH',
        json: { name: 'Blockbusters' },
      }),
      params({ id: masses.id }),
    );

    expect((await query('q=blockbusters')).length).toBe(1);
  });

  it('finds a track by a newly added tag', async () => {
    const track = await addTrack({ title: 'Tag Me', categoryId: masses.id, type: 'song' });

    await patchAudio(
      jsonRequest(`/api/admin/audio/${track.id}`, {
        method: 'PATCH',
        json: { tags: ['freshtag'] },
      }),
      params({ id: track.id }),
    );

    expect((await query('q=freshtag')).length).toBe(1);
  });
});

describe('search results are safe to publish', () => {
  it('leak no storage details', async () => {
    await addTrack({ title: 'Leak Check', categoryId: masses.id, type: 'song' });
    const media = await prisma.mediaFile.findFirstOrThrow();

    const response = await search(makeRequest('/api/search?q=leak'));
    const raw = (await response.text()).toLowerCase();

    expect(raw).not.toContain('telegram');
    expect(raw).not.toContain(media.telegramFileId.toLowerCase());
    expect(raw).not.toContain(media.telegramFileUniqueId.toLowerCase());
    expect(raw).not.toContain(media.telegramChatId.toLowerCase());
  });
});
