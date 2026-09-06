import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Identifier and slug helpers.
 *
 * Ids are URL-safe, sortable-by-creation, and 24 characters: an 8-character
 * base36 millisecond timestamp followed by 16 characters of randomness. Sorted
 * ids keep SQLite's B-tree inserts appending rather than splitting pages, and
 * they make `ORDER BY id` a usable tiebreaker.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function createId(): string {
  const time = Date.now().toString(36).padStart(8, '0');
  const bytes = randomBytes(16);
  let suffix = '';
  for (const byte of bytes) {
    suffix += ALPHABET[byte % ALPHABET.length];
  }
  return `${time}${suffix}`;
}

export function createToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export function createUuid(): string {
  return randomUUID();
}

/**
 * Convert arbitrary text into a URL slug.
 *
 * Non-ASCII scripts (Tamil, for instance) survive NFKD normalisation but not
 * the ASCII filter, so a title written entirely in Tamil would slugify to an
 * empty string. Callers must treat `''` as "fall back to something else" —
 * `uniqueSlug` does exactly that.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/**
 * Produce a slug that does not collide, asking `exists` about each candidate.
 * Falls back to a random suffix when the input slugifies to nothing.
 */
export async function uniqueSlug(
  input: string,
  exists: (slug: string) => Promise<boolean>,
  fallbackPrefix = 'item',
): Promise<string> {
  const base = slugify(input) || `${fallbackPrefix}-${randomBytes(3).toString('hex')}`;
  if (!(await exists(base))) return base;

  for (let n = 2; n <= 50; n += 1) {
    const candidate = `${base}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
  // Extremely unlikely; guarantees termination without an unbounded loop.
  return `${base}-${randomBytes(4).toString('hex')}`;
}
