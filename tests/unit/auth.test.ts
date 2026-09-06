import { describe, expect, it, beforeEach } from 'vitest';

import { hashPassword, parsePasswordHash, safeStringEqual, verifyPassword } from '@/lib/auth/password';
import {
  consume,
  LOGIN_RULE,
  reset,
  resetAllRateLimits,
  type RateLimitRule,
} from '@/lib/auth/rate-limit';

describe('password hashing', () => {
  it('produces a verifiable hash in the documented format', async () => {
    const hash = await hashPassword('a-sufficiently-long-password');

    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash.split('$')).toHaveLength(6);
    await expect(verifyPassword('a-sufficiently-long-password', hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('a-sufficiently-long-password');
    await expect(verifyPassword('a-sufficiently-long-passworD', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const first = await hashPassword('a-sufficiently-long-password');
    const second = await hashPassword('a-sufficiently-long-password');
    expect(first).not.toBe(second);
    await expect(verifyPassword('a-sufficiently-long-password', second)).resolves.toBe(true);
  });

  it('refuses to hash a short password', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/);
  });

  it('normalises unicode, so a password typed on two keyboards still matches', async () => {
    // U+00E9 vs. e + U+0301 — visually identical, different bytes.
    const composed = 'passwörd-café-1234';
    const decomposed = composed.normalize('NFD');
    expect(composed).not.toBe(decomposed);

    const hash = await hashPassword(composed);
    await expect(verifyPassword(decomposed, hash)).resolves.toBe(true);
  });

  describe('malformed stored hashes fail closed', () => {
    const cases: [string, string][] = [
      ['empty', ''],
      ['wrong algorithm', 'bcrypt$1$2$3$4$5'],
      ['too few parts', 'scrypt$16384$8$1$salt'],
      ['non-numeric parameters', 'scrypt$x$y$z$c2FsdA==$aGFzaA=='],
      ['absurd N, which would otherwise allocate gigabytes', 'scrypt$999999999$8$1$c2FsdA==$aGFzaA=='],
      ['empty salt', 'scrypt$16384$8$1$$aGFzaA=='],
    ];

    it.each(cases)('%s', async (_name, hash) => {
      expect(parsePasswordHash(hash)).toBeNull();
      // Never throws — a misconfigured hash must reject the login, not 500.
      await expect(verifyPassword('anything', hash)).resolves.toBe(false);
    });
  });
});

describe('safeStringEqual', () => {
  it('compares correctly', () => {
    expect(safeStringEqual('owner', 'owner')).toBe(true);
    expect(safeStringEqual('owner', 'Owner')).toBe(false);
    expect(safeStringEqual('owner', 'owners')).toBe(false);
    expect(safeStringEqual('', '')).toBe(true);
  });
});

describe('rate limiting', () => {
  beforeEach(() => {
    resetAllRateLimits();
  });

  it('allows a burst up to capacity then refuses', () => {
    for (let attempt = 1; attempt <= LOGIN_RULE.capacity; attempt += 1) {
      expect(consume('ip-a', LOGIN_RULE).allowed).toBe(true);
    }

    const blocked = consume('ip-a', LOGIN_RULE);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keys buckets independently, so one client cannot lock out another', () => {
    for (let attempt = 1; attempt <= LOGIN_RULE.capacity; attempt += 1) {
      consume('ip-a', LOGIN_RULE);
    }
    expect(consume('ip-a', LOGIN_RULE).allowed).toBe(false);
    expect(consume('ip-b', LOGIN_RULE).allowed).toBe(true);
  });

  it('refills over time', async () => {
    // A fast rule so the test does not have to wait 30 seconds for a token.
    const fast: RateLimitRule = { capacity: 2, refillPerSecond: 50 };

    expect(consume('refill', fast).allowed).toBe(true);
    expect(consume('refill', fast).allowed).toBe(true);
    expect(consume('refill', fast).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(consume('refill', fast).allowed).toBe(true);
  });

  it('never refills past capacity', async () => {
    const fast: RateLimitRule = { capacity: 2, refillPerSecond: 500 };
    consume('cap', fast);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(consume('cap', fast).allowed).toBe(true);
    expect(consume('cap', fast).allowed).toBe(true);
    expect(consume('cap', fast).allowed).toBe(false);
  });

  it('reset gives a key its budget back, which is what a successful login does', () => {
    for (let attempt = 1; attempt <= LOGIN_RULE.capacity; attempt += 1) {
      consume('ip-c', LOGIN_RULE);
    }
    expect(consume('ip-c', LOGIN_RULE).allowed).toBe(false);

    reset('ip-c');
    expect(consume('ip-c', LOGIN_RULE).allowed).toBe(true);
  });

  it('reports a retry delay proportional to the refill rate', () => {
    const slow: RateLimitRule = { capacity: 1, refillPerSecond: 0.1 };
    consume('slow', slow);
    const blocked = consume('slow', slow);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(9);
  });
});
