import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt.
 *
 * scrypt ships in Node's standard library, is memory-hard, and is an accepted
 * password hash (RFC 7914, OWASP-recommended). Using it avoids adding argon2 or
 * bcrypt, both of which are native addons that complicate the container build —
 * for one owner account, the difference is not worth a compiled dependency.
 *
 * Parameters follow OWASP's scrypt guidance: N=2^15, r=8, p=1 (~32 MB per
 * hash). Verification is the only hot path and it happens at most a few times
 * a day, behind rate limiting.
 *
 * Encoded form: `scrypt$N$r$p$<salt base64>$<hash base64>`
 */

const DEFAULT_N = 32768;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** scrypt needs roughly 128 * N * r bytes; give it headroom or it throws. */
const maxmemFor = (n: number, r: number) => 256 * n * r;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error('Password must be at least 12 characters.');
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: maxmemFor(DEFAULT_N, DEFAULT_R),
  });
  return [
    'scrypt',
    DEFAULT_N,
    DEFAULT_R,
    DEFAULT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

interface ParsedHash {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

export function parsePasswordHash(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const n = Number.parseInt(parts[1] ?? '', 10);
  const r = Number.parseInt(parts[2] ?? '', 10);
  const p = Number.parseInt(parts[3] ?? '', 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return null;
  // Guard against a hostile/corrupt hash asking for an unbounded allocation.
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;

  try {
    const salt = Buffer.from(parts[4] ?? '', 'base64');
    const hash = Buffer.from(parts[5] ?? '', 'base64');
    if (salt.length === 0 || hash.length === 0) return null;
    return { n, r, p, salt, hash };
  } catch {
    return null;
  }
}

/**
 * Constant-time password verification.
 *
 * Returns false for a malformed hash rather than throwing, so a misconfigured
 * ADMIN_PASSWORD_HASH fails closed instead of 500-ing with a stack trace.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), parsed.salt, parsed.hash.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: maxmemFor(parsed.n, parsed.r),
    });
  } catch {
    return false;
  }

  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * Compare two strings without leaking their contents through timing. Used for
 * the username, so that a wrong username and a wrong password cost the same.
 */
export function safeStringEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Still burn a comparison so length differences are not obviously faster.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
