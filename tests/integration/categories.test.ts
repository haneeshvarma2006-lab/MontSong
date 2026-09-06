import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as login } from '@/app/api/admin/auth/login/route';
import { GET as adminList, POST as adminCreate } from '@/app/api/admin/categories/route';
import { DELETE as adminDelete, PATCH as adminUpdate } from '@/app/api/admin/categories/[id]/route';
import { POST as adminReorder } from '@/app/api/admin/categories/reorder/route';
import { GET as publicList } from '@/app/api/categories/route';
import { prisma } from '@/lib/db';
import { resetAllRateLimits } from '@/lib/auth/rate-limit';
import { createId } from '@/lib/ids';
import type { AdminCategory, PublicCategory } from '@/lib/serializers';

import { resetJar } from '../helpers/cookie-jar';
import { jsonRequest, makeRequest, params, readJson } from '../helpers/request';
import { TEST_ENV } from '../setup';

/**
 * Category management.
 *
 * The requirement these tests hold the code to: categories are entirely
 * owner-defined, the public site reflects a change immediately, and deleting
 * one never orphans the tracks inside it.
 */

async function signIn(): Promise<void> {
  resetJar();
  resetAllRateLimits();
  const response = await login(
    jsonRequest('/api/admin/auth/login', {
      method: 'POST',
      json: { username: TEST_ENV.username, password: TEST_ENV.password },
    }),
  );
  expect(response.status).toBe(200);
}

async function create(payload: Record<string, unknown>): Promise<Response> {
  return adminCreate(jsonRequest('/api/admin/categories', { method: 'POST', json: payload }));
}

async function createOk(payload: Record<string, unknown>): Promise<AdminCategory> {
  const response = await create(payload);
  expect(response.status).toBe(201);
  return (await readJson<{ category: AdminCategory }>(response)).category;
}

beforeAll(async () => {
  await signIn();
});

beforeEach(async () => {
  await prisma.audio.deleteMany({});
  await prisma.mediaFile.deleteMany({});
  await prisma.category.deleteMany({});
  resetAllRateLimits();
});

describe('creating categories', () => {
  it('creates one and derives a slug from the name', async () => {
    const category = await createOk({ name: 'Tamil OGs' });

    expect(category).toMatchObject({
      name: 'Tamil OGs',
      slug: 'tamil-ogs',
      isPublished: true,
      audioCount: 0,
    });
  });

  it('accepts an explicit slug', async () => {
    const category = await createOk({ name: 'Background Music', slug: 'bgm' });
    expect(category.slug).toBe('bgm');
  });

  it('accepts every field the owner can set', async () => {
    const category = await createOk({
      name: 'Mass Songs',
      description: 'Loud ones.',
      icon: '🔥',
      accent: '#e0523f',
      isPublished: false,
      isFeatured: true,
    });

    expect(category).toMatchObject({
      description: 'Loud ones.',
      icon: '🔥',
      accent: '#e0523f',
      isPublished: false,
      isFeatured: true,
    });
  });

  it('appends new categories to the end rather than reshuffling the list', async () => {
    const first = await createOk({ name: 'First' });
    const second = await createOk({ name: 'Second' });
    expect(second.sortOrder).toBeGreaterThan(first.sortOrder);
  });

  it('rejects a duplicate slug with a message that names the clash', async () => {
    await createOk({ name: 'Ringtones' });
    const response = await create({ name: 'Ringtones Again', slug: 'ringtones' });

    expect(response.status).toBe(409);
    const body = await readJson<{ error: { message: string } }>(response);
    expect(body.error.message).toContain('/category/ringtones');
  });

  it('invents a slug when the name has no ASCII characters', async () => {
    const category = await createOk({ name: 'தமிழ் பாடல்கள்' });
    expect(category.slug).toMatch(/^category-[0-9a-f]{6}$/);
    expect(category.name).toBe('தமிழ் பாடல்கள்');
  });

  describe('rejects invalid input', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['an empty name', { name: '' }],
      ['a name of only whitespace', { name: '   ' }],
      ['an over-long name', { name: 'x'.repeat(200) }],
      ['a slug with spaces', { name: 'Bad', slug: 'not a slug' }],
      ['a slug with a leading hyphen', { name: 'Bad', slug: '-leading' }],
      ['a slug with path traversal', { name: 'Bad', slug: '../../etc' }],
      ['a non-hex accent', { name: 'Bad', accent: 'red' }],
      ['an over-long icon', { name: 'Bad', icon: 'x'.repeat(50) }],
    ];

    it.each(cases)('%s', async (_name, payload) => {
      const response = await create(payload);
      expect(response.status).toBe(422);
    });
  });

  it('refuses unknown fields rather than silently ignoring them', async () => {
    // Mass assignment: sortOrder is server-controlled and must not be settable.
    const response = await create({ name: 'Sneaky', sortOrder: 9999 });
    expect(response.status).toBe(422);
  });
});

describe('updating categories', () => {
  it('renames without changing the address', async () => {
    const category = await createOk({ name: 'Old Name' });

    const response = await adminUpdate(
      jsonRequest(`/api/admin/categories/${category.id}`, {
        method: 'PATCH',
        json: { name: 'New Name' },
      }),
      params({ id: category.id }),
    );

    expect(response.status).toBe(200);
    const body = await readJson<{ category: AdminCategory }>(response);
    expect(body.category.name).toBe('New Name');
    expect(body.category.slug).toBe('old-name');
  });

  it('changes the address when asked', async () => {
    const category = await createOk({ name: 'Movable' });

    const response = await adminUpdate(
      jsonRequest(`/api/admin/categories/${category.id}`, {
        method: 'PATCH',
        json: { slug: 'somewhere-else' },
      }),
      params({ id: category.id }),
    );

    expect((await readJson<{ category: AdminCategory }>(response)).category.slug).toBe(
      'somewhere-else',
    );
  });

  it('refuses to take an address another category already uses', async () => {
    await createOk({ name: 'Taken', slug: 'taken' });
    const other = await createOk({ name: 'Other' });

    const response = await adminUpdate(
      jsonRequest(`/api/admin/categories/${other.id}`, { method: 'PATCH', json: { slug: 'taken' } }),
      params({ id: other.id }),
    );
    expect(response.status).toBe(409);
  });

  it('answers 404 for a category that no longer exists', async () => {
    const response = await adminUpdate(
      jsonRequest('/api/admin/categories/does-not-exist', {
        method: 'PATCH',
        json: { name: 'Ghost' },
      }),
      params({ id: 'does-not-exist' }),
    );
    expect(response.status).toBe(404);
  });
});

describe('reordering', () => {
  it('persists a new order and the public list follows it', async () => {
    const a = await createOk({ name: 'Alpha' });
    const b = await createOk({ name: 'Beta' });
    const c = await createOk({ name: 'Gamma' });

    const response = await adminReorder(
      jsonRequest('/api/admin/categories/reorder', {
        method: 'POST',
        json: { ids: [c.id, a.id, b.id] },
      }),
    );
    expect(response.status).toBe(200);

    const listed = await readJson<{ categories: PublicCategory[] }>(
      await publicList(makeRequest('/api/categories')),
    );
    expect(listed.categories.map((category) => category.name)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('rejects an order that names an unknown category, leaving the old order intact', async () => {
    const a = await createOk({ name: 'Alpha' });
    const b = await createOk({ name: 'Beta' });

    const response = await adminReorder(
      jsonRequest('/api/admin/categories/reorder', {
        method: 'POST',
        json: { ids: [b.id, a.id, createId()] },
      }),
    );
    expect(response.status).toBe(404);

    const listed = await readJson<{ categories: PublicCategory[] }>(
      await publicList(makeRequest('/api/categories')),
    );
    expect(listed.categories.map((category) => category.name)).toEqual(['Alpha', 'Beta']);
  });

  it('rejects an empty order', async () => {
    const response = await adminReorder(
      jsonRequest('/api/admin/categories/reorder', { method: 'POST', json: { ids: [] } }),
    );
    expect(response.status).toBe(422);
  });
});

describe('deleting categories', () => {
  /** A track needs a media row; this is the smallest valid one. */
  async function seedTrack(categoryId: string, title: string): Promise<string> {
    const mediaId = createId();
    await prisma.mediaFile.create({
      data: {
        id: mediaId,
        kind: 'audio',
        telegramChatId: '-100',
        telegramMessageId: 1,
        telegramFileId: `F${mediaId}`,
        telegramFileUniqueId: `U${mediaId}`,
        mimeType: 'audio/mpeg',
        fileName: `${title}.mp3`,
        fileSize: 1024,
      },
    });

    const audioId = createId();
    await prisma.audio.create({
      data: {
        id: audioId,
        title,
        slug: title.toLowerCase().replace(/\s+/g, '-'),
        type: 'song',
        categoryId,
        mediaId,
        searchText: ` ${title.toLowerCase()} `,
      },
    });
    return audioId;
  }

  it('deletes an empty category', async () => {
    const category = await createOk({ name: 'Empty' });

    const response = await adminDelete(
      makeRequest(`/api/admin/categories/${category.id}`, { method: 'DELETE' }),
      params({ id: category.id }),
    );

    expect(response.status).toBe(200);
    expect(await readJson<{ movedAudio: number }>(response)).toMatchObject({ movedAudio: 0 });
    expect(await prisma.category.count()).toBe(0);
  });

  it('leaves tracks uncategorised rather than deleting them', async () => {
    const category = await createOk({ name: 'Doomed' });
    const trackId = await seedTrack(category.id, 'Survivor');

    const response = await adminDelete(
      makeRequest(`/api/admin/categories/${category.id}?mode=unassign`, { method: 'DELETE' }),
      params({ id: category.id }),
    );

    expect(response.status).toBe(200);
    expect(await readJson<{ movedAudio: number }>(response)).toMatchObject({ movedAudio: 1 });

    // The whole point: the track still exists, and its file is still referenced.
    const track = await prisma.audio.findUnique({ where: { id: trackId } });
    expect(track).not.toBeNull();
    expect(track?.categoryId).toBeNull();
    expect(await prisma.mediaFile.count()).toBe(1);
  });

  it('moves tracks into another category when asked', async () => {
    const from = await createOk({ name: 'From' });
    const to = await createOk({ name: 'To' });
    const trackId = await seedTrack(from.id, 'Mover');

    const response = await adminDelete(
      makeRequest(`/api/admin/categories/${from.id}?mode=reassign&target=${to.id}`, {
        method: 'DELETE',
      }),
      params({ id: from.id }),
    );

    expect(response.status).toBe(200);
    const track = await prisma.audio.findUnique({ where: { id: trackId } });
    expect(track?.categoryId).toBe(to.id);
  });

  it('refuses a reassign with no destination', async () => {
    const category = await createOk({ name: 'Needs Target' });
    await seedTrack(category.id, 'Stuck');

    const response = await adminDelete(
      makeRequest(`/api/admin/categories/${category.id}?mode=reassign`, { method: 'DELETE' }),
      params({ id: category.id }),
    );

    expect(response.status).toBe(409);
    expect(await prisma.category.count()).toBe(1);
  });

  it('refuses to move tracks into the category being deleted', async () => {
    const category = await createOk({ name: 'Self' });
    await seedTrack(category.id, 'Loop');

    const response = await adminDelete(
      makeRequest(`/api/admin/categories/${category.id}?mode=reassign&target=${category.id}`, {
        method: 'DELETE',
      }),
      params({ id: category.id }),
    );
    expect(response.status).toBe(409);
  });

  it('refuses a reassign to a category that does not exist', async () => {
    const category = await createOk({ name: 'Origin' });
    await seedTrack(category.id, 'Orphan Risk');

    const response = await adminDelete(
      makeRequest(`/api/admin/categories/${category.id}?mode=reassign&target=${createId()}`, {
        method: 'DELETE',
      }),
      params({ id: category.id }),
    );

    expect(response.status).toBe(404);
    expect(await prisma.audio.count()).toBe(1);
  });

  it('rejects an unrecognised mode', async () => {
    const category = await createOk({ name: 'Mode Check' });
    const response = await adminDelete(
      makeRequest(`/api/admin/categories/${category.id}?mode=obliterate`, { method: 'DELETE' }),
      params({ id: category.id }),
    );
    expect(response.status).toBe(400);
  });
});

describe('the public listing', () => {
  it('shows published categories and hides unpublished ones', async () => {
    await createOk({ name: 'Visible' });
    await createOk({ name: 'Hidden', isPublished: false });

    const response = await publicList(makeRequest('/api/categories'));
    const body = await readJson<{ categories: PublicCategory[] }>(response);

    expect(body.categories.map((category) => category.name)).toEqual(['Visible']);
  });

  it('reflects a new category immediately, with no cache to wait on', async () => {
    const before = await readJson<{ categories: PublicCategory[] }>(
      await publicList(makeRequest('/api/categories')),
    );

    await createOk({ name: 'Brand New' });

    const after = await readJson<{ categories: PublicCategory[] }>(
      await publicList(makeRequest('/api/categories')),
    );

    expect(after.categories).toHaveLength(before.categories.length + 1);
    expect(after.categories.some((category) => category.name === 'Brand New')).toBe(true);
  });

  it('counts only published tracks, so a card cannot promise hidden ones', async () => {
    const category = await createOk({ name: 'Counting' });

    const makeTrack = async (title: string, isPublished: boolean) => {
      const mediaId = createId();
      await prisma.mediaFile.create({
        data: {
          id: mediaId,
          kind: 'audio',
          telegramChatId: '-100',
          telegramFileId: `F${mediaId}`,
          telegramFileUniqueId: `U${mediaId}`,
          mimeType: 'audio/mpeg',
          fileName: `${title}.mp3`,
          fileSize: 100,
        },
      });
      await prisma.audio.create({
        data: {
          id: createId(),
          title,
          slug: title.toLowerCase(),
          type: 'song',
          categoryId: category.id,
          mediaId,
          isPublished,
          searchText: ` ${title.toLowerCase()} `,
        },
      });
    };

    await makeTrack('shown', true);
    await makeTrack('draft', false);

    const body = await readJson<{ categories: PublicCategory[] }>(
      await publicList(makeRequest('/api/categories')),
    );
    expect(body.categories[0]?.audioCount).toBe(1);

    // The admin listing counts everything.
    const adminBody = await readJson<{ categories: AdminCategory[] }>(
      await adminList(makeRequest('/api/admin/categories')),
    );
    expect(adminBody.categories[0]?.audioCount).toBe(2);
  });
});
