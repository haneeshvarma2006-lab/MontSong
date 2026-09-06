import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as login } from '@/app/api/admin/auth/login/route';
import { POST as logout } from '@/app/api/admin/auth/logout/route';
import { GET as sessionInfo } from '@/app/api/admin/session/route';
import { GET as listCategories, POST as createCategory } from '@/app/api/admin/categories/route';
import { GET as adminAudioList } from '@/app/api/admin/audio/route';
import { GET as adminAnalytics } from '@/app/api/admin/analytics/route';
import { GET as adminStorage } from '@/app/api/admin/storage/route';
import { SESSION_COOKIE_NAME } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { resetAllRateLimits } from '@/lib/auth/rate-limit';

import { getCookie, resetJar } from '../helpers/cookie-jar';
import { jsonRequest, makeRequest, readJson } from '../helpers/request';
import { TEST_ENV } from '../setup';

/**
 * Authentication and authorisation, end to end through the real route handlers.
 *
 * The claim being tested is the one that matters most: the admin API is closed
 * to everyone but the owner, and closing it does not depend on the admin UI
 * being hidden.
 */

const CREDENTIALS = { username: TEST_ENV.username, password: TEST_ENV.password };

async function signIn(): Promise<Response> {
  return login(jsonRequest('/api/admin/auth/login', { method: 'POST', json: CREDENTIALS }));
}

beforeEach(async () => {
  resetJar();
  resetAllRateLimits();
  await prisma.session.deleteMany({});
  await prisma.adminUser.updateMany({ data: { failedLoginCount: 0, lockedUntil: null } });
});

afterEach(async () => {
  await prisma.session.deleteMany({});
});

describe('sign in', () => {
  it('accepts the owner and issues a session', async () => {
    const response = await signIn();
    expect(response.status).toBe(200);

    const body = await readJson<{ ok: boolean; csrfToken: string; user: { username: string } }>(
      response,
    );
    expect(body.ok).toBe(true);
    expect(body.user.username).toBe(TEST_ENV.username);
    expect(body.csrfToken).toBeTruthy();

    // A session row exists, and the cookie is not the stored value.
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);

    const cookie = getCookie(SESSION_COOKIE_NAME);
    expect(cookie).toBeTruthy();
    expect(sessions[0]?.tokenHash).not.toBe(cookie);
  });

  it('rejects a wrong password with the same message as a wrong username', async () => {
    const wrongPassword = await login(
      jsonRequest('/api/admin/auth/login', {
        method: 'POST',
        json: { ...CREDENTIALS, password: 'not-the-password' },
      }),
    );
    resetAllRateLimits();
    const wrongUsername = await login(
      jsonRequest('/api/admin/auth/login', {
        method: 'POST',
        json: { username: 'someone-else', password: TEST_ENV.password },
      }),
    );

    expect(wrongPassword.status).toBe(401);
    expect(wrongUsername.status).toBe(401);

    const a = await readJson<{ error: { message: string } }>(wrongPassword);
    const b = await readJson<{ error: { message: string } }>(wrongUsername);
    // Identical wording: the response must not reveal which half was wrong.
    expect(a.error.message).toBe(b.error.message);
  });

  it('never reveals whether the account exists through a different status code', async () => {
    const response = await login(
      jsonRequest('/api/admin/auth/login', {
        method: 'POST',
        json: { username: 'ghost', password: 'whatever-long-enough' },
      }),
    );
    expect(response.status).toBe(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it('rate limits repeated attempts from one client', async () => {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await login(
        jsonRequest('/api/admin/auth/login', {
          method: 'POST',
          json: { ...CREDENTIALS, password: 'wrong' },
        }),
      );
      lastStatus = response.status;
      if (lastStatus === 429) break;
    }

    expect(lastStatus).toBe(429);
  });

  it('locks the account after enough consecutive failures', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      resetAllRateLimits(); // isolate the account lockout from the IP limiter
      await login(
        jsonRequest('/api/admin/auth/login', {
          method: 'POST',
          json: { ...CREDENTIALS, password: 'wrong' },
        }),
      );
    }

    const user = await prisma.adminUser.findFirst();
    expect(user?.failedLoginCount).toBeGreaterThanOrEqual(5);
    expect(user?.lockedUntil).not.toBeNull();

    resetAllRateLimits();
    // Even the correct password is refused while the lockout holds.
    const response = await signIn();
    expect(response.status).toBe(429);
  });

  it('clears the failure count on a successful sign-in', async () => {
    await login(
      jsonRequest('/api/admin/auth/login', {
        method: 'POST',
        json: { ...CREDENTIALS, password: 'wrong' },
      }),
    );
    resetAllRateLimits();

    await signIn();
    const user = await prisma.adminUser.findFirst();
    expect(user?.failedLoginCount).toBe(0);
    expect(user?.lockedUntil).toBeNull();
    expect(user?.lastLoginAt).not.toBeNull();
  });

  it('rejects a cross-origin sign-in attempt', async () => {
    const response = await login(
      jsonRequest('/api/admin/auth/login', {
        method: 'POST',
        json: CREDENTIALS,
        origin: 'https://evil.example',
      }),
    );
    expect(response.status).toBe(403);
  });

  it('rejects a malformed body without leaking internals', async () => {
    const response = await login(
      jsonRequest('/api/admin/auth/login', { method: 'POST', json: { username: '' } }),
    );
    expect(response.status).toBe(422);

    const body = await readJson<{ error: { message: string; diagnostic?: string } }>(response);
    // Sign-in is a public endpoint, so no diagnostic detail is attached.
    expect(body.error.diagnostic).toBeUndefined();
  });
});

describe('admin routes reject anonymous callers', () => {
  const routes: [string, () => Promise<Response>][] = [
    ['GET /api/admin/session', () => sessionInfo(makeRequest('/api/admin/session', { authenticated: false }))],
    ['GET /api/admin/categories', () => listCategories(makeRequest('/api/admin/categories', { authenticated: false }))],
    [
      'POST /api/admin/categories',
      () =>
        createCategory(
          jsonRequest('/api/admin/categories', {
            method: 'POST',
            json: { name: 'Sneaky' },
            authenticated: false,
          }),
        ),
    ],
    ['GET /api/admin/audio', () => adminAudioList(makeRequest('/api/admin/audio', { authenticated: false }))],
    ['GET /api/admin/analytics', () => adminAnalytics(makeRequest('/api/admin/analytics', { authenticated: false }))],
    ['GET /api/admin/storage', () => adminStorage(makeRequest('/api/admin/storage', { authenticated: false }))],
  ];

  it.each(routes)('%s answers 401', async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(401);
  });

  it('does not create anything when a write is refused', async () => {
    const before = await prisma.category.count();
    await createCategory(
      jsonRequest('/api/admin/categories', {
        method: 'POST',
        json: { name: 'Should Not Exist' },
        authenticated: false,
      }),
    );
    expect(await prisma.category.count()).toBe(before);
  });

  it('rejects a forged session cookie', async () => {
    const response = await sessionInfo(
      makeRequest('/api/admin/session', {
        authenticated: false,
        headers: { cookie: `${SESSION_COOKIE_NAME}=totally-made-up-token` },
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe('CSRF protection', () => {
  beforeEach(async () => {
    await signIn();
  });

  it('accepts a write that carries the double-submit token', async () => {
    const response = await createCategory(
      jsonRequest('/api/admin/categories', { method: 'POST', json: { name: 'With Token' } }),
    );
    expect(response.status).toBe(201);
    await prisma.category.deleteMany({ where: { name: 'With Token' } });
  });

  it('refuses a write with a valid session but no CSRF token', async () => {
    const response = await createCategory(
      jsonRequest('/api/admin/categories', {
        method: 'POST',
        json: { name: 'No Token' },
        csrf: false,
      }),
    );

    expect(response.status).toBe(403);
    expect(await prisma.category.count({ where: { name: 'No Token' } })).toBe(0);
  });

  it('refuses a write whose CSRF token belongs to another session', async () => {
    const response = await createCategory(
      jsonRequest('/api/admin/categories', {
        method: 'POST',
        json: { name: 'Wrong Token' },
        csrf: false,
        headers: { 'x-montsong-csrf': 'a-token-from-somewhere-else' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('refuses a write from a foreign origin even with a good session', async () => {
    const response = await createCategory(
      jsonRequest('/api/admin/categories', {
        method: 'POST',
        json: { name: 'Cross Site' },
        origin: 'https://evil.example',
      }),
    );
    expect(response.status).toBe(403);
  });

  it('refuses a write with no Origin and no Referer at all', async () => {
    const response = await createCategory(
      jsonRequest('/api/admin/categories', {
        method: 'POST',
        json: { name: 'Headless' },
        origin: null,
      }),
    );
    expect(response.status).toBe(403);
  });

  it('does not require a token for a read', async () => {
    const response = await listCategories(makeRequest('/api/admin/categories'));
    expect(response.status).toBe(200);
  });
});

describe('sign out', () => {
  it('deletes the session server-side, so the cookie is dead even if captured', async () => {
    await signIn();
    const cookie = getCookie(SESSION_COOKIE_NAME);
    expect(await prisma.session.count()).toBe(1);

    const response = await logout(makeRequest('/api/admin/auth/logout', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(await prisma.session.count()).toBe(0);

    // Replaying the captured cookie now fails.
    const replay = await sessionInfo(
      makeRequest('/api/admin/session', {
        authenticated: false,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      }),
    );
    expect(replay.status).toBe(401);
  });

  it('succeeds even with no session, so a stale tab does not see an error', async () => {
    const response = await logout(
      makeRequest('/api/admin/auth/logout', { method: 'POST', authenticated: false }),
    );
    expect(response.status).toBe(200);
  });
});

describe('session lifecycle', () => {
  it('rejects an expired session and cleans the row up', async () => {
    await signIn();
    const session = await prisma.session.findFirst();
    expect(session).not.toBeNull();

    await prisma.session.update({
      where: { id: session!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await sessionInfo(makeRequest('/api/admin/session'));
    expect(response.status).toBe(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it('reports the signed-in owner and a usable CSRF token', async () => {
    await signIn();
    const response = await sessionInfo(makeRequest('/api/admin/session'));
    expect(response.status).toBe(200);

    const body = await readJson<{ user: { username: string }; csrfToken: string }>(response);
    expect(body.user.username).toBe(TEST_ENV.username);
    expect(body.csrfToken).toBe(getCookie('montsong_csrf'));
  });
});
