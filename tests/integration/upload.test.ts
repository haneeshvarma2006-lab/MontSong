import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';

import { POST as login } from '@/app/api/admin/auth/login/route';
import { POST as adminCreateCategory } from '@/app/api/admin/categories/route';
import { GET as adminAudioList, POST as upload } from '@/app/api/admin/audio/route';
import { DELETE as deleteAudio, PATCH as patchAudio } from '@/app/api/admin/audio/[id]/route';
import { GET as storageStatus } from '@/app/api/admin/storage/route';
import {
  DELETE as discardOrphan,
  POST as adoptOrphan,
} from '@/app/api/admin/storage/orphans/[id]/route';
import { resetAllRateLimits } from '@/lib/auth/rate-limit';
import { prisma } from '@/lib/db';
import type { AdminAudio, AdminCategory } from '@/lib/serializers';

import { resetJar } from '../helpers/cookie-jar';
import {
  flacBytes,
  jpegBytes,
  m4aBytes,
  mp3Bytes,
  mp4VideoBytes,
  multipart,
  oggOpusBytes,
  pngBytes,
  shellScriptBytes,
  wavBytes,
} from '../helpers/fixtures';
import { FakeTelegram, installFakeTelegram } from '../helpers/telegram';
import { jsonRequest, makeRequest, params, readJson } from '../helpers/request';
import { TEST_ENV } from '../setup';

/**
 * The upload pipeline, end to end.
 *
 * This is the flow the whole application exists to support: bytes arrive,
 * they are validated against their own content, they are stored in Telegram,
 * and a durable record ties the two together — with no state in which a file
 * exists in storage and nothing on this side knows about it.
 */

const telegram = new FakeTelegram();
let restoreFetch: () => void;
let category: AdminCategory;

function uploadRequest(options: {
  audio?: { fileName: string; contentType: string; bytes: Buffer };
  cover?: { fileName: string; contentType: string; bytes: Buffer };
  metadata?: Record<string, unknown>;
  fields?: Record<string, string>;
}): Request {
  const files = [];
  if (options.audio) files.push({ field: 'audio', ...options.audio });
  if (options.cover) files.push({ field: 'cover', ...options.cover });

  const { body, contentType } = multipart({
    fields: {
      ...(options.metadata ? { metadata: JSON.stringify(options.metadata) } : {}),
      ...options.fields,
    },
    files,
  });

  return makeRequest('/api/admin/audio', {
    method: 'POST',
    body: new Uint8Array(body),
    headers: { 'content-type': contentType, 'content-length': String(body.byteLength) },
  });
}

async function uploadTrack(
  overrides: Partial<{ title: string; bytes: Buffer; fileName: string; contentType: string }> = {},
): Promise<AdminAudio> {
  const response = await upload(
    uploadRequest({
      audio: {
        fileName: overrides.fileName ?? 'track.mp3',
        contentType: overrides.contentType ?? 'audio/mpeg',
        bytes: overrides.bytes ?? mp3Bytes(6000),
      },
      metadata: { title: overrides.title ?? 'A Track', categoryId: category.id },
    }),
  );

  expect(response.status).toBe(201);
  return (await readJson<{ audio: AdminAudio }>(response)).audio;
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
    jsonRequest('/api/admin/categories', { method: 'POST', json: { name: 'Uploads' } }),
  );
  category = (await readJson<{ category: AdminCategory }>(response)).category;
});

afterAll(() => {
  restoreFetch();
});

beforeEach(async () => {
  resetAllRateLimits();
  telegram.reset();
  await prisma.audio.deleteMany({});
  await prisma.uploadIntent.deleteMany({});
  await prisma.mediaFile.deleteMany({});
  await prisma.cachedFile.deleteMany({});
});

describe('a successful upload', () => {
  it('stores the file in Telegram and records everything about it', async () => {
    const bytes = mp3Bytes(8000);

    const response = await upload(
      uploadRequest({
        audio: { fileName: 'vaathi coming.mp3', contentType: 'audio/mpeg', bytes },
        metadata: {
          title: 'Vaathi Coming',
          artist: 'Anirudh',
          type: 'song',
          categoryId: category.id,
          description: 'A loud one.',
          tags: ['vijay', 'mass'],
          isPublished: true,
          durationSec: 214,
        },
      }),
    );

    expect(response.status).toBe(201);
    const { audio } = await readJson<{ audio: AdminAudio }>(response);

    // The API answer describes the track without mentioning storage.
    expect(audio).toMatchObject({
      title: 'Vaathi Coming',
      artist: 'Anirudh',
      slug: 'vaathi-coming',
      format: 'MP3',
      durationSec: 214,
      isPublished: true,
      fileSize: bytes.byteLength,
    });
    expect([...audio.tags].sort()).toEqual(['mass', 'vijay']);
    expect(audio.streamUrl).toBe(`/api/audio/${audio.id}/stream`);

    // The bytes really did reach Telegram, unmodified.
    const stored = telegram.findByName('vaathi coming.mp3');
    expect(stored).toBeDefined();
    expect(Buffer.compare(stored!.bytes, bytes)).toBe(0);

    // And the identifiers were recorded on our side.
    const media = await prisma.mediaFile.findFirst();
    expect(media).toMatchObject({
      telegramFileId: stored!.fileId,
      telegramFileUniqueId: stored!.fileUniqueId,
      telegramMessageId: stored!.messageId,
      mimeType: 'audio/mpeg',
      fileSize: bytes.byteLength,
      status: 'stored',
    });
    expect(media?.sha256).toHaveLength(64);
  });

  it('sends MP3 through sendAudio so Telegram parses its metadata', async () => {
    await uploadTrack({ bytes: mp3Bytes(), fileName: 'a.mp3', contentType: 'audio/mpeg' });
    expect(telegram.calls.map((call) => call.method)).toContain('sendAudio');
  });

  it('sends formats Telegram would not treat as music through sendDocument', async () => {
    // sendAudio is documented as expecting .MP3/.M4A; a FLAC goes as a document
    // so its bytes are stored exactly as uploaded.
    await uploadTrack({
      bytes: flacBytes(4000),
      fileName: 'lossless.flac',
      contentType: 'audio/flac',
      title: 'Lossless',
    });

    expect(telegram.calls.map((call) => call.method)).toContain('sendDocument');
    expect(telegram.calls.map((call) => call.method)).not.toContain('sendAudio');
  });

  it('marks the upload record committed once the track exists', async () => {
    const audio = await uploadTrack();
    const intent = await prisma.uploadIntent.findFirst();

    expect(intent).toMatchObject({ status: 'committed', audioId: audio.id });
  });

  it('stores optional artwork alongside the track', async () => {
    const response = await upload(
      uploadRequest({
        audio: { fileName: 'withart.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes() },
        cover: { fileName: 'art.jpg', contentType: 'image/jpeg', bytes: jpegBytes(2000) },
        metadata: { title: 'With Art', categoryId: category.id },
      }),
    );

    expect(response.status).toBe(201);
    const { audio } = await readJson<{ audio: AdminAudio }>(response);
    expect(audio.coverUrl).toBe(`/api/audio/${audio.id}/cover`);

    expect(telegram.calls.map((call) => call.method)).toContain('sendPhoto');
    expect(await prisma.mediaFile.count({ where: { kind: 'image' } })).toBe(1);
  });

  it('keeps the track when only the artwork fails', async () => {
    telegram.configure({
      failures: { sendPhoto: [{ status: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' }] },
    });

    const response = await upload(
      uploadRequest({
        audio: { fileName: 'artfail.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes() },
        cover: { fileName: 'bad.png', contentType: 'image/png', bytes: pngBytes() },
        metadata: { title: 'Art Failed', categoryId: category.id },
      }),
    );

    // Artwork is optional; losing it must not lose an already-stored track.
    expect(response.status).toBe(201);
    const { audio } = await readJson<{ audio: AdminAudio }>(response);
    expect(audio.coverUrl).toBeNull();
    expect(audio.title).toBe('Art Failed');
  });

  it('accepts metadata as individual form fields, not only as JSON', async () => {
    const response = await upload(
      uploadRequest({
        audio: { fileName: 'fields.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes() },
        fields: {
          title: 'From Fields',
          artist: 'Someone',
          type: 'ringtone',
          tags: 'one, two',
          isPublished: 'false',
        },
      }),
    );

    expect(response.status).toBe(201);
    const { audio } = await readJson<{ audio: AdminAudio }>(response);
    expect(audio).toMatchObject({ title: 'From Fields', type: 'ringtone', isPublished: false });
    expect([...audio.tags].sort()).toEqual(['one', 'two']);
  });

  it('leaves no temporary files behind', async () => {
    await uploadTrack({ title: 'Cleanup Check' });
    expect(readdirSync(TEST_ENV.uploadDir)).toHaveLength(0);
  });

  it('accepts every supported format', async () => {
    const formats: [string, string, Buffer][] = [
      ['a.mp3', 'audio/mpeg', mp3Bytes()],
      ['b.m4a', 'audio/mp4', m4aBytes()],
      ['c.wav', 'audio/wav', wavBytes()],
      ['d.flac', 'audio/flac', flacBytes()],
      ['e.opus', 'audio/opus', oggOpusBytes()],
    ];

    for (const [fileName, contentType, bytes] of formats) {
      const track = await uploadTrack({ fileName, contentType, bytes, title: `Track ${fileName}` });
      expect(track.id).toBeTruthy();
    }

    expect(await prisma.audio.count()).toBe(formats.length);
  });
});

describe('upload validation', () => {
  it('rejects a script renamed to .mp3, even with a matching declared type', async () => {
    const response = await upload(
      uploadRequest({
        audio: { fileName: 'payload.mp3', contentType: 'audio/mpeg', bytes: shellScriptBytes() },
        metadata: { title: 'Nope' },
      }),
    );

    expect(response.status).toBe(415);
    // Nothing reached Telegram, and nothing was recorded.
    expect(telegram.files.size).toBe(0);
    expect(await prisma.mediaFile.count()).toBe(0);
    expect(await prisma.audio.count()).toBe(0);
  });

  it('rejects a real image submitted as the audio file', async () => {
    const response = await upload(
      uploadRequest({
        audio: { fileName: 'cover.jpg', contentType: 'image/jpeg', bytes: jpegBytes() },
        metadata: { title: 'Wrong Kind' },
      }),
    );

    expect(response.status).toBe(415);
    const body = await readJson<{ error: { message: string } }>(response);
    expect(body.error.message).toContain('JPEG');
  });

  it('rejects a video container even though it is legitimate media', async () => {
    const response = await upload(
      uploadRequest({
        audio: { fileName: 'clip.mp4', contentType: 'audio/mp4', bytes: mp4VideoBytes() },
        metadata: { title: 'Video' },
      }),
    );
    expect(response.status).toBe(415);
  });

  it('rejects a declared type that contradicts the bytes', async () => {
    const response = await upload(
      uploadRequest({
        audio: { fileName: 'liar.flac', contentType: 'audio/flac', bytes: mp3Bytes() },
        metadata: { title: 'Mismatch' },
      }),
    );

    expect(response.status).toBe(415);
    const body = await readJson<{ error: { message: string } }>(response);
    expect(body.error.message).toMatch(/says it is|contents are/);
  });

  it('rejects an empty file', async () => {
    const response = await upload(
      uploadRequest({
        audio: { fileName: 'empty.mp3', contentType: 'audio/mpeg', bytes: Buffer.alloc(0) },
        metadata: { title: 'Empty' },
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.audio.count()).toBe(0);
  });

  it('rejects a file larger than the configured ceiling, before storing anything', async () => {
    const oversized = Buffer.concat([mp3Bytes(64), Buffer.alloc(21 * 1024 * 1024, 0x55)]);

    const response = await upload(
      uploadRequest({
        audio: { fileName: 'huge.mp3', contentType: 'audio/mpeg', bytes: oversized },
        metadata: { title: 'Too Big' },
      }),
    );

    expect(response.status).toBe(413);
    expect(telegram.files.size).toBe(0);
    expect(readdirSync(TEST_ENV.uploadDir)).toHaveLength(0);
  });

  it('rejects an upload with no audio part', async () => {
    const response = await upload(uploadRequest({ metadata: { title: 'Nothing' } }));
    expect(response.status).toBe(409);
  });

  it('rejects a request that is not multipart', async () => {
    const response = await upload(
      jsonRequest('/api/admin/audio', { method: 'POST', json: { title: 'Wrong Encoding' } }),
    );
    expect(response.status).toBe(415);
  });

  it('rejects invalid metadata without storing the file', async () => {
    const response = await upload(
      uploadRequest({
        audio: { fileName: 'nometa.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes() },
        metadata: { title: '' },
      }),
    );

    expect(response.status).toBe(422);
    expect(telegram.files.size).toBe(0);
  });

  it('rejects a category that does not exist', async () => {
    const response = await upload(
      uploadRequest({
        audio: { fileName: 'badcat.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes() },
        metadata: { title: 'Bad Category', categoryId: 'no-such-category' },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('refuses a byte-identical re-upload', async () => {
    const bytes = mp3Bytes(3000);
    await uploadTrack({ bytes, title: 'Original' });

    const response = await upload(
      uploadRequest({
        audio: { fileName: 'copy.mp3', contentType: 'audio/mpeg', bytes },
        metadata: { title: 'Duplicate', categoryId: category.id },
      }),
    );

    expect(response.status).toBe(409);
    // One copy in storage, not two.
    expect(telegram.files.size).toBe(1);
  });

  it('sanitises a traversal filename before it reaches storage', async () => {
    await upload(
      uploadRequest({
        audio: {
          fileName: '../../../etc/passwd.mp3',
          contentType: 'audio/mpeg',
          bytes: mp3Bytes(),
        },
        metadata: { title: 'Traversal', categoryId: category.id },
      }),
    );

    const media = await prisma.mediaFile.findFirst();
    expect(media?.fileName).toBe('passwd.mp3');
    expect(media?.fileName).not.toContain('..');
    expect(media?.fileName).not.toContain('/');
  });

  it('requires authentication', async () => {
    const { body, contentType } = multipart({
      fields: { metadata: JSON.stringify({ title: 'Anonymous' }) },
      files: [
        { field: 'audio', fileName: 'anon.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes() },
      ],
    });

    const response = await upload(
      makeRequest('/api/admin/audio', {
        method: 'POST',
        body: new Uint8Array(body),
        headers: { 'content-type': contentType },
        authenticated: false,
      }),
    );

    expect(response.status).toBe(401);
    expect(telegram.files.size).toBe(0);
  });
});

describe('when storage fails', () => {
  it('reports the storage service being unreachable, and stores nothing', async () => {
    telegram.configure({ offline: true });

    const response = await upload(
      uploadRequest({
        audio: { fileName: 'offline.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes() },
        metadata: { title: 'Offline', categoryId: category.id },
      }),
    );

    expect(response.status).toBe(503);
    expect(await prisma.audio.count()).toBe(0);
    expect(await prisma.mediaFile.count()).toBe(0);

    // The attempt is still on record, marked failed.
    const intent = await prisma.uploadIntent.findFirst();
    expect(intent?.status).toBe('failed');
  });

  it('explains a file Telegram will not hand back, rather than a raw error', async () => {
    telegram.configure({
      failures: { sendAudio: [{ status: 400, description: 'Bad Request: file is too big' }] },
    });

    const response = await upload(
      uploadRequest({
        audio: { fileName: 'toobig.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes() },
        metadata: { title: 'Too Big For Telegram', categoryId: category.id },
      }),
    );

    expect(response.status).toBe(413);
    const body = await readJson<{ error: { code: string; message: string } }>(response);
    expect(body.error.code).toBe('file_too_large_for_telegram');
    expect(body.error.message).toContain('20 MB');
  });

  it('waits out a rate limit and succeeds on the retry', async () => {
    telegram.configure({
      failures: {
        sendAudio: [{ status: 429, description: 'Too Many Requests', retryAfter: 1 }],
      },
    });

    const response = await upload(
      uploadRequest({
        audio: { fileName: 'ratelimited.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes() },
        metadata: { title: 'Rate Limited', categoryId: category.id },
      }),
    );

    expect(response.status).toBe(201);
    // Two calls: the refused one and the retry that honoured retry_after.
    expect(telegram.calls.filter((call) => call.method === 'sendAudio')).toHaveLength(2);
  });

  it('surfaces a permissions problem in words the owner can act on', async () => {
    telegram.configure({
      failures: {
        sendAudio: [{ status: 400, description: 'Bad Request: have no rights to send a message' }],
      },
    });

    const response = await upload(
      uploadRequest({
        audio: { fileName: 'norights.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes() },
        metadata: { title: 'No Rights', categoryId: category.id },
      }),
    );

    expect(response.status).toBe(503);
    const body = await readJson<{ error: { message: string } }>(response);
    expect(body.error.message).toContain('administrator');
  });
});

describe('reconciliation', () => {
  /**
   * The scenario the UploadIntent table exists for: Telegram accepted the file
   * and the process then failed before a track row was written. Simulated here
   * by rewinding an intent to the state it would have been left in.
   */
  async function makeOrphan(): Promise<string> {
    const audio = await uploadTrack({ title: 'Will Be Orphaned', fileName: 'orphan.mp3' });

    const intent = await prisma.uploadIntent.findFirstOrThrow();
    await prisma.audio.delete({ where: { id: audio.id } });
    await prisma.mediaFile.deleteMany({});
    await prisma.uploadIntent.update({
      where: { id: intent.id },
      data: { status: 'uploaded', audioId: null },
    });

    return intent.id;
  }

  it('lists an upload that reached storage but never became a track', async () => {
    await makeOrphan();

    const response = await storageStatus(makeRequest('/api/admin/storage'));
    const body = await readJson<{ orphans: { id: string; status: string; hasTelegramFile: boolean }[] }>(
      response,
    );

    expect(body.orphans).toHaveLength(1);
    expect(body.orphans[0]).toMatchObject({ status: 'uploaded', hasTelegramFile: true });
  });

  it('recovers an orphan without re-uploading it', async () => {
    const intentId = await makeOrphan();
    const callsBefore = telegram.calls.length;

    const response = await adoptOrphan(
      makeRequest(`/api/admin/storage/orphans/${intentId}`, { method: 'POST' }),
      params({ id: intentId }),
    );

    expect(response.status).toBe(200);
    // The media row is back, and nothing was sent to Telegram to get it.
    expect(await prisma.mediaFile.count()).toBe(1);
    expect(telegram.calls.length).toBe(callsBefore);

    const intent = await prisma.uploadIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe('committed');
  });

  it('discards an orphan and removes the stored copy', async () => {
    const intentId = await makeOrphan();
    const intent = await prisma.uploadIntent.findUniqueOrThrow({ where: { id: intentId } });

    const response = await discardOrphan(
      makeRequest(`/api/admin/storage/orphans/${intentId}`, { method: 'DELETE' }),
      params({ id: intentId }),
    );

    expect(response.status).toBe(200);
    expect(await readJson<{ telegramDeleted: boolean }>(response)).toMatchObject({
      telegramDeleted: true,
    });
    expect(telegram.deletedMessages).toContain(intent.telegramMessageId);
    expect(await prisma.uploadIntent.count({ where: { id: intentId } })).toBe(0);
  });

  it('keeps a record when the stored copy cannot be removed', async () => {
    const intentId = await makeOrphan();
    telegram.configure({
      failures: {
        deleteMessage: [{ status: 400, description: 'Bad Request: message can\'t be deleted' }],
      },
    });

    const response = await discardOrphan(
      makeRequest(`/api/admin/storage/orphans/${intentId}`, { method: 'DELETE' }),
      params({ id: intentId }),
    );

    expect(response.status).toBe(200);
    expect(await readJson<{ telegramDeleted: boolean }>(response)).toMatchObject({
      telegramDeleted: false,
    });

    // Not silently dropped — marked so it stays auditable.
    const intent = await prisma.uploadIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe('abandoned');
  });

  it('refuses to recover an upload that never reached storage', async () => {
    telegram.configure({ offline: true });
    await upload(
      uploadRequest({
        audio: { fileName: 'never.mp3', contentType: 'audio/mpeg', bytes: mp3Bytes() },
        metadata: { title: 'Never Stored', categoryId: category.id },
      }),
    );
    telegram.configure({});

    const intent = await prisma.uploadIntent.findFirstOrThrow();
    const response = await adoptOrphan(
      makeRequest(`/api/admin/storage/orphans/${intent.id}`, { method: 'POST' }),
      params({ id: intent.id }),
    );

    expect(response.status).toBe(409);
  });
});

describe('deleting a track', () => {
  it('removes the row, the media record and the stored copy', async () => {
    const audio = await uploadTrack({ title: 'Delete Me', fileName: 'deleteme.mp3' });
    const media = await prisma.mediaFile.findFirstOrThrow();

    const response = await deleteAudio(
      makeRequest(`/api/admin/audio/${audio.id}`, { method: 'DELETE' }),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(200);
    expect(await prisma.audio.count()).toBe(0);
    expect(await prisma.mediaFile.count()).toBe(0);
    expect(telegram.deletedMessages).toContain(media.telegramMessageId);
  });

  it('still deletes the track when storage refuses, and says so', async () => {
    const audio = await uploadTrack({ title: 'Stubborn', fileName: 'stubborn.mp3' });
    telegram.configure({
      failures: { deleteMessage: [{ status: 400, description: 'Bad Request: message not found' }] },
    });

    const response = await deleteAudio(
      makeRequest(`/api/admin/audio/${audio.id}`, { method: 'DELETE' }),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(200);
    const body = await readJson<{ storageWarnings: string[] }>(response);
    expect(body.storageWarnings).toHaveLength(1);
    expect(body.storageWarnings[0]).toContain('stubborn.mp3');

    // The visitor-facing outcome is what was asked for: the track is gone.
    expect(await prisma.audio.count()).toBe(0);
  });

  it('answers 404 for a track that no longer exists', async () => {
    const response = await deleteAudio(
      makeRequest('/api/admin/audio/nope', { method: 'DELETE' }),
      params({ id: 'nope' }),
    );
    expect(response.status).toBe(404);
  });
});

describe('editing a track', () => {
  it('publishes and unpublishes', async () => {
    const audio = await uploadTrack({ title: 'Toggle Me', fileName: 'toggle.mp3' });

    const off = await patchAudio(
      makeRequest(`/api/admin/audio/${audio.id}?action=publish&value=false`, { method: 'PATCH' }),
      params({ id: audio.id }),
    );
    expect((await readJson<{ audio: AdminAudio }>(off)).audio.isPublished).toBe(false);

    const on = await patchAudio(
      makeRequest(`/api/admin/audio/${audio.id}?action=publish&value=true`, { method: 'PATCH' }),
      params({ id: audio.id }),
    );
    expect((await readJson<{ audio: AdminAudio }>(on)).audio.isPublished).toBe(true);
  });

  it('moves a track between categories', async () => {
    const audio = await uploadTrack({ title: 'Mover', fileName: 'mover.mp3' });
    const other = (
      await readJson<{ category: AdminCategory }>(
        await adminCreateCategory(
          jsonRequest('/api/admin/categories', {
            method: 'POST',
            json: { name: `Destination ${Date.now()}` },
          }),
        ),
      )
    ).category;

    const response = await patchAudio(
      jsonRequest(`/api/admin/audio/${audio.id}?action=move`, {
        method: 'PATCH',
        json: { categoryId: other.id },
      }),
      params({ id: audio.id }),
    );

    expect((await readJson<{ audio: AdminAudio }>(response)).audio.categoryId).toBe(other.id);
  });

  it('keeps the search haystack in step with a rename', async () => {
    const audio = await uploadTrack({ title: 'Before', fileName: 'rename.mp3' });

    await patchAudio(
      jsonRequest(`/api/admin/audio/${audio.id}`, {
        method: 'PATCH',
        json: { title: 'After', artist: 'New Artist' },
      }),
      params({ id: audio.id }),
    );

    const row = await prisma.audio.findUniqueOrThrow({ where: { id: audio.id } });
    expect(row.searchText).toContain('after');
    expect(row.searchText).toContain('new artist');
    expect(row.searchText).not.toContain('before');
  });

  it('refuses unknown fields on an update', async () => {
    const audio = await uploadTrack({ title: 'Locked Down', fileName: 'locked.mp3' });

    const response = await patchAudio(
      jsonRequest(`/api/admin/audio/${audio.id}`, {
        method: 'PATCH',
        json: { title: 'Fine', downloadCount: 99999 },
      }),
      params({ id: audio.id }),
    );

    expect(response.status).toBe(422);
    const row = await prisma.audio.findUniqueOrThrow({ where: { id: audio.id } });
    expect(row.downloadCount).toBe(0);
  });
});

describe('the admin listing', () => {
  it('filters, searches and paginates', async () => {
    await uploadTrack({ title: 'Alpha Song', fileName: 'alpha.mp3', bytes: mp3Bytes(1001) });
    await uploadTrack({ title: 'Beta Song', fileName: 'beta.mp3', bytes: mp3Bytes(1002) });
    const gamma = await uploadTrack({
      title: 'Gamma Track',
      fileName: 'gamma.mp3',
      bytes: mp3Bytes(1003),
    });

    await patchAudio(
      makeRequest(`/api/admin/audio/${gamma.id}?action=publish&value=false`, { method: 'PATCH' }),
      params({ id: gamma.id }),
    );

    const all = await readJson<{ total: number }>(
      await adminAudioList(makeRequest('/api/admin/audio')),
    );
    expect(all.total).toBe(3);

    const drafts = await readJson<{ items: AdminAudio[] }>(
      await adminAudioList(makeRequest('/api/admin/audio?status=unpublished')),
    );
    expect(drafts.items.map((item) => item.title)).toEqual(['Gamma Track']);

    const searched = await readJson<{ items: AdminAudio[] }>(
      await adminAudioList(makeRequest('/api/admin/audio?q=song')),
    );
    expect(searched.items).toHaveLength(2);

    const paged = await readJson<{ items: AdminAudio[]; pageCount: number }>(
      await adminAudioList(makeRequest('/api/admin/audio?perPage=2&page=2')),
    );
    expect(paged.pageCount).toBe(2);
    expect(paged.items).toHaveLength(1);
  });
});
