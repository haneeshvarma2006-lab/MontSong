import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as login } from '@/app/api/admin/auth/login/route';
import { GET as adminAudioList } from '@/app/api/admin/audio/route';
import { SESSION_COOKIE_NAME } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { resetAllRateLimits } from '@/lib/auth/rate-limit';
import { resetConfigForTests } from '@/lib/env';

import { getCookie, resetJar } from '../helpers/cookie-jar';
import { jsonRequest, makeRequest } from '../helpers/request';
import { TEST_ENV } from '../setup';

/**
 * The two levers the documentation offers for "sign out everywhere" must
 * actually sign people out.
 *
 * A security review found both inoperative. AUTH_SECRET was not part of the
 * stored session hash, so rotating it left every row matchable; and the code
 * that clears sessions on a password change ran only inside the login handler,
 * so changing the password and restarting revoked nothing until somebody
 * attempted a login — which an attacker holding a live cookie will never do.
 *
 * Both are the owner's response to a stolen cookie, so both are tested from
 * the attacker's side: does the captured token still open the admin API?
 */

const CREDENTIALS = { username: TEST_ENV.username, password: TEST_ENV.password };

/** Sign in and return the raw session cookie value — the thing an attacker steals. */
async function stealSessionToken(): Promise<string> {
  const response = await login(
    jsonRequest('/api/admin/auth/login', { method: 'POST', json: CREDENTIALS }),
  );
  expect(response.status).toBe(200);
  const token = getCookie(SESSION_COOKIE_NAME);
  expect(token).toBeTruthy();
  return token as string;
}

/** Use a bare token against an admin read, bypassing the cookie jar entirely. */
async function adminReadWith(token: string): Promise<number> {
  const request = makeRequest('/api/admin/audio', {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  const response = await adminAudioList(request);
  return response.status;
}

const originalSecret = process.env.AUTH_SECRET;
const originalHash = process.env.ADMIN_PASSWORD_HASH;

beforeEach(async () => {
  resetJar();
  resetAllRateLimits();
  await prisma.session.deleteMany({});
  await prisma.adminUser.updateMany({ data: { failedLoginCount: 0, lockedUntil: null } });
});

afterEach(async () => {
  process.env.AUTH_SECRET = originalSecret;
  process.env.ADMIN_PASSWORD_HASH = originalHash;
  resetConfigForTests();
  await prisma.session.deleteMany({});
});

describe('rotating AUTH_SECRET', () => {
  it('a captured session token stops working', async () => {
    const stolen = await stealSessionToken();
    expect(await adminReadWith(stolen)).toBe(200);

    // The owner runs `npm run auth:secret`, pastes the new value, restarts.
    process.env.AUTH_SECRET = Buffer.alloc(48, 42).toString('base64');
    resetConfigForTests();

    expect(await adminReadWith(stolen)).toBe(401);
  });

  it('leaves no session row that the old token could match', async () => {
    const stolen = await stealSessionToken();
    process.env.AUTH_SECRET = Buffer.alloc(48, 43).toString('base64');
    resetConfigForTests();

    await adminReadWith(stolen);

    // Even if a row survives, it must not be reachable by the stolen token.
    expect(await adminReadWith(stolen)).toBe(401);
  });
});

describe('rotating the password', () => {
  it('a captured session token stops working without anyone signing in again', async () => {
    const stolen = await stealSessionToken();
    expect(await adminReadWith(stolen)).toBe(200);

    // The owner runs `npm run admin:password` and restarts. Crucially, no
    // login happens afterwards — the attacker has a working cookie and no
    // reason to visit the sign-in page.
    process.env.ADMIN_PASSWORD_HASH =
      'scrypt:32768:8:1:cm90YXRlZC1zYWx0LTE2Ynk=:cm90YXRlZC1oYXNoLXZhbHVlLXRoYXQtaXMtZGlmZmVyZW50';
    resetConfigForTests();

    expect(await adminReadWith(stolen)).toBe(401);
  });

  it('drops the stale session rows rather than only rejecting them', async () => {
    const stolen = await stealSessionToken();
    expect(await prisma.session.count()).toBeGreaterThan(0);

    process.env.ADMIN_PASSWORD_HASH =
      'scrypt:32768:8:1:c2Vjb25kLXJvdGF0aW9uLXNhbHQ=:c2Vjb25kLXJvdGF0aW9uLWhhc2gtdmFsdWUtaGVyZQ==';
    resetConfigForTests();

    await adminReadWith(stolen);
    expect(await prisma.session.count()).toBe(0);
  });
});

describe('an untouched configuration', () => {
  it('keeps a valid session working across repeated requests', async () => {
    const token = await stealSessionToken();
    expect(await adminReadWith(token)).toBe(200);
    expect(await adminReadWith(token)).toBe(200);
  });
});
