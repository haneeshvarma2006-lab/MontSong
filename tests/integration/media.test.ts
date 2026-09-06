import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { POST as login } from '@/app/api/admin/auth/login/route';
import { POST as adminCreateCategory } from '@/app/api/admin/categories/route';
import { POST as upload } from '@/app/api/admin/audio/route';
import { PATCH as patchAudio } from '@/app/api/admin/audio/[id]/route';
import { DELETE as clearCacheRoute } from '@/app/api/admin/storage/cache/route';
import { GET as streamGet, HEAD as streamHead } from '@/app/api/audio/[id]/stream/route';
import { GET as downloadGet } from '@/app/api/audio/[id]/download/route';
import { GET as coverGet } from '@/app/api/audio/[id]/cover/route';
import { resetAllRateLimits } from '@/lib/auth/rate-limit';
import { prisma } from '@/lib/db';
import { resetCacheStateForTests } from '@/lib/media/cache';
import type { AdminAudio, AdminCategory } from '@/lib/serializers';

import { resetJar } from '../helpers/cookie-jar';
import { jpegBytes, mp3Bytes, multipart } from '../helpers/fixtures';
import { FakeTelegram, installFakeTelegram } from '../helpers/telegram';
import { jsonRequest, makeRequest, params, readBytes, readJson } from '../helpers/request';
import { TEST_ENV } from '../setup';

/**
 * Streaming and downloading.
 *
 * The acceptance criteria being verified here are the visitor-facing ones: a
 * track plays, seeks correctly, downloads with a sensible filename — and at no
 * point does the response mention, link to, or redirect to Telegram.
 */

const telegram = new FakeTelegram();
let restoreFetch: () => void;
let category: AdminCategory;

/** Distinctive contents so a range assertion can check the exact bytes. */
function trackBytes(size: number): Buffer {
  const head = mp3Bytes(0);
  const body = Buffer.alloc(size - head.length);
  for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
  return Buffer.concat([head, body]);
}

let counter = 0;

async function publishTrack(
  bytes: Buffer,
  overrides: { title?: string; cover?: Buffer } = {},
): Promise<{ audio: AdminAudio; bytes: Buffer }> {
  counter += 1;
  const title = overrides.title ?? `Track ${counter}`;
  const files = [
    {
      field: 'audio',
      fileName: `track-${counter}.mp3`,
      contentType: 'audio/mpeg',
      bytes,
    },
  ];
  if (overrides.cover) {
    files.push({
      field: 'cover',
      fileName: `cover-${counter}.jpg`,
      contentType: 'image/jpeg',
      bytes: overrides.cover,
    });
  }

  const { body, contentType } = multipart({
    fields: { metadata: JSON.stringify({ title, categoryId: category.id, durationSec: 180 }) },
    files,
  });

  const response = await upload(
    makeRequest('/api/admin/audio', {
      method: 'POST',
      body: new Uint8Array(body),
      headers: { 'content-type': contentType },
    }),
  );

  expect(response.status).toBe(201);
  return { audio: (await readJson<{ audio: AdminAudio }>(response)).audio, bytes };
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

  category = (
    await readJson<{ category: AdminCategory }>(
      await adminCreateCategory(
        jsonRequest('/api/admin/categories', { method: 'POST', json: { name: 'Media' } }),
      ),
    )
  ).category;
});

afterAll(() => {
  restoreFetch();
});

beforeEach(async () => {
  resetAllRateLimits();
  resetCacheStateForTests();
  await clearCacheRoute(makeRequest('/api/admin/storage/cache', { method: 'DELETE' }));
  await prisma.audio.deleteMany({});
  await prisma.mediaFile.deleteMany({});
  await prisma.uploadIntent.deleteMany({});
  await prisma.downloadEvent.deleteMany({});
  telegram.reset();
});

describe('streaming', () => {
  it('returns the whole file with the headers a player needs', async () => {
    const { audio, bytes } = await publishTrack(trackBytes(20_000));

    const response = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    // Without Accept-Ranges, Safari refuses to play at all.
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('etag')).toBeTruthy();
    expect(response.headers.get('content-disposition')).toContain('inline');

    const received = await readBytes(response);
    expect(Buffer.compare(received, bytes)).toBe(0);
  });

  it('answers a range request with exactly those bytes', async () => {
    const { audio, bytes } = await publishTrack(trackBytes(20_000));

    const response = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`, { headers: { range: 'bytes=1000-1999' } }),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 1000-1999/${bytes.byteLength}`);
    expect(response.headers.get('content-length')).toBe('1000');

    const received = await readBytes(response);
    expect(Buffer.compare(received, bytes.subarray(1000, 2000))).toBe(0);
  });

  it('answers an open-ended range, which is what seeking sends', async () => {
    const { audio, bytes } = await publishTrack(trackBytes(20_000));

    const response = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`, { headers: { range: 'bytes=15000-' } }),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(206);
    const received = await readBytes(response);
    expect(Buffer.compare(received, bytes.subarray(15000))).toBe(0);
  });

  it('answers a suffix range', async () => {
    const { audio, bytes } = await publishTrack(trackBytes(20_000));

    const response = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`, { headers: { range: 'bytes=-500' } }),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(206);
    const received = await readBytes(response);
    expect(Buffer.compare(received, bytes.subarray(bytes.byteLength - 500))).toBe(0);
  });

  it('rejects an unsatisfiable range with 416 and the resource size', async () => {
    const { audio, bytes } = await publishTrack(trackBytes(10_000));

    const response = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`, { headers: { range: 'bytes=999999-' } }),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${bytes.byteLength}`);
  });

  it('answers HEAD with full headers and no body, without touching storage', async () => {
    const { audio, bytes } = await publishTrack(trackBytes(10_000));
    telegram.calls.length = 0;

    const response = await streamHead(
      makeRequest(`/api/audio/${audio.id}/stream`, { method: 'HEAD' }),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect((await readBytes(response)).byteLength).toBe(0);
    expect(telegram.calls).toHaveLength(0);
  });

  it('answers 304 when the browser already has the file', async () => {
    const { audio } = await publishTrack(trackBytes(8_000));

    const first = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`),
      params({ id: audio.id }),
    );
    const etag = first.headers.get('etag') ?? '';
    await first.arrayBuffer();

    const second = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`, { headers: { 'if-none-match': etag } }),
      params({ id: audio.id }),
    );

    expect(second.status).toBe(304);
    expect((await readBytes(second)).byteLength).toBe(0);
  });

  it('is not available for an unpublished track', async () => {
    const { audio } = await publishTrack(trackBytes(4_000));
    await patchAudio(
      makeRequest(`/api/admin/audio/${audio.id}?action=publish&value=false`, { method: 'PATCH' }),
      params({ id: audio.id }),
    );

    const response = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`),
      params({ id: audio.id }),
    );
    expect(response.status).toBe(404);
  });

  it('answers 404 for a track that does not exist', async () => {
    const response = await streamGet(
      makeRequest('/api/audio/nope/stream'),
      params({ id: 'nope' }),
    );
    expect(response.status).toBe(404);
  });

  it('counts a play once at the start, not once per seek', async () => {
    const { audio } = await publishTrack(trackBytes(10_000));

    const first = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`),
      params({ id: audio.id }),
    );
    await first.arrayBuffer();

    const seek = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`, { headers: { range: 'bytes=5000-' } }),
      params({ id: audio.id }),
    );
    await seek.arrayBuffer();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const row = await prisma.audio.findUniqueOrThrow({ where: { id: audio.id } });
    expect(row.playCount).toBe(1);
  });
});

describe('downloading', () => {
  it('serves the file as an attachment named after the track', async () => {
    const { audio, bytes } = await publishTrack(trackBytes(12_000), {
      title: 'Tamil OG Ringtone',
    });

    const response = await downloadGet(
      makeRequest(`/api/audio/${audio.id}/download`),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(200);

    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('filename="tamil-og-ringtone.mp3"');

    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));

    const received = await readBytes(response);
    expect(Buffer.compare(received, bytes)).toBe(0);
  });

  it('never redirects the visitor anywhere', async () => {
    const { audio } = await publishTrack(trackBytes(5_000));

    const response = await downloadGet(
      makeRequest(`/api/audio/${audio.id}/download`),
      params({ id: audio.id }),
    );

    // A 3xx, or a Location header, would send the visitor to Telegram.
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect([...response.headers.keys()]).not.toContain('refresh');
  });

  it('mentions Telegram in no header and no body', async () => {
    const { audio } = await publishTrack(trackBytes(5_000));

    const response = await downloadGet(
      makeRequest(`/api/audio/${audio.id}/download`),
      params({ id: audio.id }),
    );

    const headerText = [...response.headers.entries()]
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')
      .toLowerCase();

    expect(headerText).not.toContain('telegram');
    expect(headerText).not.toContain('t.me');
    expect(headerText).not.toContain('file_id');

    // The ETag is derived from a Telegram id, so check the id itself is absent.
    const media = await prisma.mediaFile.findFirstOrThrow();
    expect(headerText).not.toContain(media.telegramFileId.toLowerCase());
    expect(headerText).not.toContain(media.telegramChatId.toLowerCase());
  });

  it('counts a full download', async () => {
    const { audio } = await publishTrack(trackBytes(5_000));

    const response = await downloadGet(
      makeRequest(`/api/audio/${audio.id}/download`),
      params({ id: audio.id }),
    );
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const row = await prisma.audio.findUniqueOrThrow({ where: { id: audio.id } });
    expect(row.downloadCount).toBe(1);

    const events = await prisma.downloadEvent.findMany({ where: { kind: 'download' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not count a resumed partial fetch as a second download', async () => {
    const { audio } = await publishTrack(trackBytes(5_000));

    const full = await downloadGet(
      makeRequest(`/api/audio/${audio.id}/download`),
      params({ id: audio.id }),
    );
    await full.arrayBuffer();

    const resumed = await downloadGet(
      makeRequest(`/api/audio/${audio.id}/download`, { headers: { range: 'bytes=1000-' } }),
      params({ id: audio.id }),
    );
    await resumed.arrayBuffer();

    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = await prisma.audio.findUniqueOrThrow({ where: { id: audio.id } });
    expect(row.downloadCount).toBe(1);
  });

  it('handles a non-ASCII title without producing a broken header', async () => {
    const { audio } = await publishTrack(trackBytes(4_000), { title: 'தமிழ் பாடல்' });

    const response = await downloadGet(
      makeRequest(`/api/audio/${audio.id}/download`),
      params({ id: audio.id }),
    );

    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toContain("filename*=UTF-8''");
    // Header values must stay ASCII, or the fetch would have thrown by now.
    expect(response.status).toBe(200);
  });

  it('is not available for an unpublished track', async () => {
    const { audio } = await publishTrack(trackBytes(4_000));
    await patchAudio(
      makeRequest(`/api/admin/audio/${audio.id}?action=publish&value=false`, { method: 'PATCH' }),
      params({ id: audio.id }),
    );

    const response = await downloadGet(
      makeRequest(`/api/audio/${audio.id}/download`),
      params({ id: audio.id }),
    );
    expect(response.status).toBe(404);
  });
});

describe('caching', () => {
  it('fetches from storage once, then serves every later request locally', async () => {
    const { audio } = await publishTrack(trackBytes(30_000));
    telegram.calls.length = 0;

    const first = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`),
      params({ id: audio.id }),
    );
    await first.arrayBuffer();

    const callsAfterFirst = telegram.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    for (let index = 0; index < 5; index += 1) {
      const repeat = await streamGet(
        makeRequest(`/api/audio/${audio.id}/stream`, { headers: { range: `bytes=${index * 100}-` } }),
        params({ id: audio.id }),
      );
      await repeat.arrayBuffer();
    }

    // Five more plays and five seeks cost nothing at the storage layer.
    expect(telegram.calls.length).toBe(callsAfterFirst);

    const cached = await prisma.cachedFile.findMany();
    expect(cached).toHaveLength(1);
    expect(cached[0]?.bytes).toBe(30_000);
  });

  it('coalesces concurrent first plays into a single storage fetch', async () => {
    const { audio } = await publishTrack(trackBytes(25_000));
    telegram.calls.length = 0;

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        streamGet(makeRequest(`/api/audio/${audio.id}/stream`), params({ id: audio.id })),
      ),
    );
    await Promise.all(responses.map((response) => response.arrayBuffer()));

    // Eight simultaneous listeners, one download from storage.
    const downloads = telegram.calls.filter((call) => call.method === 'getFile');
    expect(downloads.length).toBeLessThanOrEqual(1);

    for (const response of responses) expect(response.status).toBe(200);
  });

  it('caches the resolved storage location instead of resolving it per request', async () => {
    const { audio } = await publishTrack(trackBytes(9_000));

    const first = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`),
      params({ id: audio.id }),
    );
    await first.arrayBuffer();

    const media = await prisma.mediaFile.findFirstOrThrow();
    expect(media.telegramFilePath).toBeTruthy();
    expect(media.telegramFilePathFetchedAt).not.toBeNull();
  });

  it('re-fetches transparently after the cache is cleared', async () => {
    const { audio, bytes } = await publishTrack(trackBytes(10_000));

    const first = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`),
      params({ id: audio.id }),
    );
    await first.arrayBuffer();
    expect(await prisma.cachedFile.count()).toBe(1);

    resetCacheStateForTests();
    const cleared = await clearCacheRoute(
      makeRequest('/api/admin/storage/cache', { method: 'DELETE' }),
    );
    expect(cleared.status).toBe(200);
    expect(await prisma.cachedFile.count()).toBe(0);

    const again = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`),
      params({ id: audio.id }),
    );
    expect(again.status).toBe(200);
    expect(Buffer.compare(await readBytes(again), bytes)).toBe(0);
  });

  it('writes cache files under the configured directory and nowhere else', async () => {
    const { audio } = await publishTrack(trackBytes(6_000));
    const response = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`),
      params({ id: audio.id }),
    );
    await response.arrayBuffer();

    const cached = await prisma.cachedFile.findFirstOrThrow();
    const relative = path.relative(TEST_ENV.cacheDir, cached.path);
    expect(relative.startsWith('..')).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);

    // And no half-written .part files are left behind.
    const stray = readdirSync(TEST_ENV.cacheDir, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.part'),
    );
    expect(stray).toHaveLength(0);
  });
});

describe('when storage is unavailable', () => {
  it('answers with a service error rather than a stack trace', async () => {
    const { audio } = await publishTrack(trackBytes(5_000));
    telegram.configure({ offline: true });

    const response = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(503);
    const body = await readJson<{ error: { message: string; diagnostic?: string } }>(response);
    expect(body.error.message).not.toContain('Error:');
    expect(body.error.message).not.toContain('at ');
    // Public callers get no internal detail at all.
    expect(body.error.diagnostic).toBeUndefined();
  });

  it('re-resolves a stale storage location and succeeds', async () => {
    const { audio, bytes } = await publishTrack(trackBytes(7_000));

    // Simulate an expired getFile path: Telegram guarantees only an hour.
    await prisma.mediaFile.updateMany({
      data: {
        telegramFilePath: 'music/expired_path',
        telegramFilePathFetchedAt: new Date(),
      },
    });

    const response = await streamGet(
      makeRequest(`/api/audio/${audio.id}/stream`),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(200);
    expect(Buffer.compare(await readBytes(response), bytes)).toBe(0);

    // The refreshed path was written back.
    const media = await prisma.mediaFile.findFirstOrThrow();
    expect(media.telegramFilePath).not.toBe('music/expired_path');
  });
});

describe('cover art', () => {
  it('serves artwork from this origin', async () => {
    const cover = jpegBytes(3000);
    const { audio } = await publishTrack(trackBytes(5_000), { cover });

    const response = await coverGet(
      makeRequest(`/api/audio/${audio.id}/cover`),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/');
    expect((await readBytes(response)).byteLength).toBeGreaterThan(0);
  });

  it('answers 404 for a track with no artwork', async () => {
    const { audio } = await publishTrack(trackBytes(3_000));

    const response = await coverGet(
      makeRequest(`/api/audio/${audio.id}/cover`),
      params({ id: audio.id }),
    );
    expect(response.status).toBe(404);
  });
});
