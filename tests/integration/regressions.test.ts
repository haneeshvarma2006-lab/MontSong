import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as login } from '@/app/api/admin/auth/login/route';
import { POST as adminCreateCategory } from '@/app/api/admin/categories/route';
import { DELETE as adminDeleteCategory } from '@/app/api/admin/categories/[id]/route';
import { GET as adminAudioList, POST as upload } from '@/app/api/admin/audio/route';
import { PATCH as patchAudio } from '@/app/api/admin/audio/[id]/route';
import { POST as setCover } from '@/app/api/admin/audio/[id]/cover/route';
import { GET as search } from '@/app/api/search/route';
import { prisma } from '@/lib/db';
import { resetAllRateLimits } from '@/lib/auth/rate-limit';
import * as cache from '@/lib/media/cache';
import { openMedia } from '@/lib/telegram/storage';
import type { AdminAudio, AdminCategory } from '@/lib/serializers';

import { resetJar } from '../helpers/cookie-jar';
import { jpegBytes, mp3Bytes, multipart, pngBytes } from '../helpers/fixtures';
import { FakeTelegram, installFakeTelegram } from '../helpers/telegram';
import { jsonRequest, makeRequest, params, readJson } from '../helpers/request';
import { TEST_ENV } from '../setup';

/**
 * Defects found by a code review of the whole branch, each reproduced here
 * before it was fixed.
 *
 * They share a shape worth naming: every one of them succeeded loudly. The
 * request returned 200 or 201, the UI said "Saved", and the wrong thing
 * happened quietly — a field that would not clear, artwork silently dropped,
 * a cache entry that validated against its own truncation. Tests that only
 * assert status codes cannot see any of them, so each test below checks the
 * state that was actually left behind.
 */

const telegram = new FakeTelegram();
let restoreFetch: () => void;
let category: AdminCategory;

function uploadRequest(options: {
  audio?: { fileName: string; contentType: string; bytes: Buffer };
  cover?: { fileName: string; contentType: string; bytes: Buffer };
  metadata?: Record<string, unknown>;
}): Request {
  const files = [];
  if (options.audio) files.push({ field: 'audio', ...options.audio });
  if (options.cover) files.push({ field: 'cover', ...options.cover });

  const { body, contentType } = multipart({
    fields: options.metadata ? { metadata: JSON.stringify(options.metadata) } : {},
    files,
  });

  return makeRequest('/api/admin/audio', {
    method: 'POST',
    body: new Uint8Array(body),
    headers: { 'content-type': contentType, 'content-length': String(body.byteLength) },
  });
}

async function uploadTrack(
  metadata: Record<string, unknown> = {},
  cover?: { fileName: string; contentType: string; bytes: Buffer },
): Promise<{ audio: AdminAudio; warning?: string }> {
  const response = await upload(
    uploadRequest({
      audio: { fileName: 'track.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes(4000 + Math.floor(Math.random() * 4000)) },
      cover,
      metadata: { title: 'A Track', categoryId: category.id, ...metadata },
    }),
  );
  expect(response.status).toBe(201);
  return readJson<{ audio: AdminAudio; warning?: string }>(response);
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
  const response = await adminCreateCategory(
    jsonRequest('/api/admin/categories', { method: 'POST', json: { name: 'Regressions' } }),
  );
  category = (await readJson<{ category: AdminCategory }>(response)).category;
});

afterAll(() => {
  restoreFetch();
});

beforeEach(() => {
  resetAllRateLimits();
});

describe('clearing a text field', () => {
  it('actually clears the artist', async () => {
    const { audio } = await uploadTrack({ artist: 'Ilaiyaraaja' });
    expect(audio.artist).toBe('Ilaiyaraaja');

    const response = await patchAudio(
      jsonRequest(`/api/admin/audio/${audio.id}`, { method: 'PATCH', json: { artist: '' } }),
      params({ id: audio.id }),
    );
    expect(response.status).toBe(200);

    // The bug: '' became undefined, the repository skipped the key, and the
    // response cheerfully echoed the unchanged row back.
    const after = await prisma.audio.findUniqueOrThrow({ where: { id: audio.id } });
    expect(after.artist).toBeNull();
  });

  it('actually clears the description', async () => {
    const { audio } = await uploadTrack({ description: 'Some notes' });

    await patchAudio(
      jsonRequest(`/api/admin/audio/${audio.id}`, { method: 'PATCH', json: { description: '' } }),
      params({ id: audio.id }),
    );

    const after = await prisma.audio.findUniqueOrThrow({ where: { id: audio.id } });
    expect(after.description).toBeNull();
  });

  it('leaves an unmentioned field alone', async () => {
    const { audio } = await uploadTrack({ artist: 'Keep Me' });

    await patchAudio(
      jsonRequest(`/api/admin/audio/${audio.id}`, { method: 'PATCH', json: { title: 'Renamed' } }),
      params({ id: audio.id }),
    );

    const after = await prisma.audio.findUniqueOrThrow({ where: { id: audio.id } });
    expect(after.title).toBe('Renamed');
    expect(after.artist).toBe('Keep Me');
  });
});

describe('artwork shared between tracks', () => {
  it('reuses the stored image instead of colliding on it', async () => {
    // Real Telegram returns the same file_unique_id for identical bytes, and
    // that column is unique — so the second use of one image used to be a 500
    // with its upload intent stranded as an orphan.
    const artwork = jpegBytes(700);

    const first = await uploadTrack({ title: 'Track One' }, {
      fileName: 'art.jpg', contentType: 'image/jpeg', bytes: artwork,
    });
    const second = await uploadTrack({ title: 'Track Two' }, {
      fileName: 'art.jpg', contentType: 'image/jpeg', bytes: artwork,
    });

    expect(first.warning).toBeUndefined();
    expect(second.warning).toBeUndefined();

    const one = await prisma.audio.findUniqueOrThrow({ where: { id: first.audio.id } });
    const two = await prisma.audio.findUniqueOrThrow({ where: { id: second.audio.id } });
    expect(one.coverMediaId).not.toBeNull();
    expect(two.coverMediaId).toBe(one.coverMediaId);
  });

  it('reuses it when set through the cover endpoint too', async () => {
    const artwork = pngBytes(650);
    const { audio: a } = await uploadTrack({ title: 'Cover A' });
    const { audio: b } = await uploadTrack({ title: 'Cover B' });

    for (const id of [a.id, b.id]) {
      const { body, contentType } = multipart({
        fields: {},
        files: [{ field: 'cover', fileName: 'c.png', contentType: 'image/png', bytes: artwork }],
      });
      const response = await setCover(
        makeRequest(`/api/admin/audio/${id}/cover`, {
          method: 'POST',
          body: new Uint8Array(body),
          headers: { 'content-type': contentType, 'content-length': String(body.byteLength) },
        }),
        params({ id }),
      );
      expect(response.status).toBe(200);
    }

    const rowA = await prisma.audio.findUniqueOrThrow({ where: { id: a.id } });
    const rowB = await prisma.audio.findUniqueOrThrow({ where: { id: b.id } });
    expect(rowB.coverMediaId).toBe(rowA.coverMediaId);
  });

  it('leaves no stranded upload intent behind', async () => {
    const stranded = await prisma.uploadIntent.count({
      where: { status: { in: ['received', 'uploading', 'uploaded'] } },
    });
    expect(stranded).toBe(0);
  });
});

describe('a cover that cannot be stored', () => {
  it('tells the admin instead of reporting plain success', async () => {
    // A .jpg that is really a shell script fails content sniffing. The track
    // is still saved — artwork is optional — but the response used to be a
    // bare 201, so the admin only discovered the loss by spotting the
    // placeholder later.
    const result = await uploadTrack({ title: 'Bad Art' }, {
      fileName: 'art.jpg',
      contentType: 'image/jpeg',
      bytes: Buffer.from('#!/bin/sh\necho not an image\n'),
    });

    expect(result.audio.id).toBeTruthy();
    expect(result.warning).toBeTruthy();
    expect(result.warning).toMatch(/artwork/i);

    const row = await prisma.audio.findUniqueOrThrow({ where: { id: result.audio.id } });
    expect(row.coverMediaId).toBeNull();
  });
});

describe('deleting a category', () => {
  it('rebuilds the search text of the tracks it moved', async () => {
    const doomed = (
      await readJson<{ category: AdminCategory }>(
        await adminCreateCategory(
          jsonRequest('/api/admin/categories', { method: 'POST', json: { name: 'Doomedcat' } }),
        ),
      )
    ).category;
    const destination = (
      await readJson<{ category: AdminCategory }>(
        await adminCreateCategory(
          jsonRequest('/api/admin/categories', { method: 'POST', json: { name: 'Survivorcat' } }),
        ),
      )
    ).category;

    const { audio } = await uploadTrack({ title: 'Moved Track', categoryId: doomed.id });

    const response = await adminDeleteCategory(
      makeRequest(`/api/admin/categories/${doomed.id}?mode=reassign&target=${destination.id}`, {
        method: 'DELETE',
      }),
      params({ id: doomed.id }),
    );
    expect(response.status).toBe(200);

    const row = await prisma.audio.findUniqueOrThrow({ where: { id: audio.id } });
    expect(row.categoryId).toBe(destination.id);

    // The bug: searchText still carried the deleted category's name and not
    // the new one, so search answered for a category that no longer existed.
    expect(row.searchText).not.toContain('doomedcat');
    expect(row.searchText).toContain('survivorcat');
  });

  it('drops the old name from public search results', async () => {
    const doomed = (
      await readJson<{ category: AdminCategory }>(
        await adminCreateCategory(
          jsonRequest('/api/admin/categories', { method: 'POST', json: { name: 'Vanishingcat' } }),
        ),
      )
    ).category;

    await uploadTrack({ title: 'Orphan Track', categoryId: doomed.id, isPublished: true });

    await adminDeleteCategory(
      makeRequest(`/api/admin/categories/${doomed.id}?mode=unassign`, { method: 'DELETE' }),
      params({ id: doomed.id }),
    );

    const response = await search(makeRequest('/api/search?q=vanishingcat'));
    const body = await readJson<{ results: unknown[] }>(response);
    expect(body.results).toHaveLength(0);
  });
});

describe('the media cache', () => {
  it('refuses to commit a fill that arrived short', async () => {
    // lookup() validates a cached file against the byte count store() recorded,
    // so a truncated fill used to record its own truncated length, validate
    // against itself forever, and be served under the full Content-Length.
    const fileUniqueId = `TRUNCATED_${Date.now()}`;
    const short = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    const entry = await cache.store(fileUniqueId, short, 9000);

    expect(entry).toBeNull();
    expect(await cache.lookup(fileUniqueId)).toBeNull();
  });

  it('still commits a fill that arrived complete', async () => {
    const fileUniqueId = `COMPLETE_${Date.now()}`;
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const whole = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });

    const entry = await cache.store(fileUniqueId, whole, payload.byteLength);

    expect(entry?.bytes).toBe(payload.byteLength);
    expect(await cache.lookup(fileUniqueId)).not.toBeNull();
    await cache.purge(fileUniqueId);
  });
});

describe('a listener who navigates away mid-track', () => {
  it('is not mistaken for a storage failure and retried', async () => {
    // openMedia used to catch every error, including an abort, and respond by
    // clearing the cached file path and spending a fresh getFile. Browsers
    // abandon media range requests constantly, so the busier a track was, the
    // more often its perfectly good path was thrown away.
    const { audio } = await uploadTrack({ title: 'Abandoned' });
    const row = await prisma.audio.findUniqueOrThrow({
      where: { id: audio.id },
      include: { media: true },
    });

    // Resolve the path once, so the count below measures only the retry and
    // not the legitimate first resolution. Re-read afterwards: openMedia
    // persists the resolved path, and a stale row would resolve it again.
    const warm = await openMedia(row.media);
    await warm.body.cancel().catch(() => undefined);
    const warmed = await prisma.mediaFile.findUniqueOrThrow({ where: { id: row.media.id } });

    const before = telegram.calls.filter((call) => call.method === 'getFile').length;

    const controller = new AbortController();
    controller.abort();

    await expect(openMedia(warmed, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    const after = telegram.calls.filter((call) => call.method === 'getFile').length;
    expect(after).toBe(before);

    // And the resolved path it already held is still there.
    const media = await prisma.mediaFile.findUniqueOrThrow({ where: { id: row.media.id } });
    expect(media.telegramFilePath).not.toBeNull();
  });
});

describe('admin listing after all of this', () => {
  it('still returns every track', async () => {
    const response = await adminAudioList(makeRequest('/api/admin/audio'));
    expect(response.status).toBe(200);
    const body = await readJson<{ items: AdminAudio[] }>(response);
    expect(body.items.length).toBeGreaterThan(0);
  });
});
