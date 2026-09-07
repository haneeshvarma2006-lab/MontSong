/**
 * Test bootstrap.
 *
 * Runs before any test module is imported, which matters because several
 * modules under test read their configuration at import time — the Prisma
 * client opens its SQLite handle when `src/lib/db.ts` is first loaded, and
 * `getConfig()` memoises the environment. Setting everything here means each
 * test file gets its own database file and a known configuration.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, vi } from 'vitest';

import { jar } from './helpers/cookie-jar';

const root = process.cwd();
const workspace = mkdtempSync(path.join(tmpdir(), 'montsong-test-'));

const databaseFile = path.join(workspace, 'test.db');
const cacheDir = path.join(workspace, 'cache');
const uploadDir = path.join(workspace, 'uploads');
mkdirSync(cacheDir, { recursive: true });
mkdirSync(uploadDir, { recursive: true });

// A fixed scrypt hash of "test-password-1234", generated with the same
// parameters the application uses. Hardcoded so the suite does not spend
// ~100 ms hashing on every file.
const TEST_PASSWORD = 'test-password-1234';

// NODE_ENV is typed read-only by @types/node; the assignment is legitimate
// here because this runs before anything reads it.
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.DATABASE_URL = `file:${databaseFile}`;
process.env.TELEGRAM_BOT_TOKEN = '111222333:TEST-TOKEN-VALUE-FOR-UNIT-TESTS-ONLY';
process.env.TELEGRAM_STORAGE_CHAT_ID = '-1009999999999';
process.env.ADMIN_USERNAME = 'test-owner';
process.env.AUTH_SECRET = Buffer.alloc(48, 7).toString('base64');
process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';
process.env.NEXT_PUBLIC_SITE_NAME = 'MontSong Test';
process.env.MEDIA_CACHE_DIR = cacheDir;
process.env.UPLOAD_TMP_DIR = uploadDir;
process.env.MAX_AUDIO_UPLOAD_BYTES = String(20 * 1024 * 1024);
process.env.MAX_IMAGE_UPLOAD_BYTES = String(5 * 1024 * 1024);
process.env.LOG_LEVEL = 'error';

/**
 * Apply the real migrations rather than a hand-written schema, so a schema
 * change that the migrations do not cover fails the suite instead of passing
 * against a fiction.
 */
function applyMigrations(): void {
  const migrationsDir = path.join(root, 'prisma', 'migrations');
  const database = new Database(databaseFile);
  database.pragma('foreign_keys = ON');

  const directories = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const directory of directories) {
    const sql = readFileSync(path.join(migrationsDir, directory, 'migration.sql'), 'utf8');
    database.exec(sql);
  }

  database.close();
}

applyMigrations();

// The password hash has to be generated after AUTH_SECRET is set but before the
// app reads ADMIN_PASSWORD_HASH, and hashing is deliberately slow — so do it
// once here, synchronously, via the same code path the app uses.
const { scryptSync, randomBytes } = await import('node:crypto');
const salt = randomBytes(16);
const derived = scryptSync(TEST_PASSWORD, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 256 * 16384 * 8 });
process.env.ADMIN_PASSWORD_HASH = [
  'scrypt',
  16384,
  8,
  1,
  salt.toString('base64'),
  derived.toString('base64'),
].join(':');

export const TEST_ENV = {
  workspace,
  databaseFile,
  cacheDir,
  uploadDir,
  password: TEST_PASSWORD,
  username: 'test-owner',
};

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * `next/headers` only works inside a Next request scope. The tests exercise
 * route handlers directly, so it is backed by an in-memory jar instead — the
 * handlers keep their real cookie-writing code path.
 */
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const entry = jar.get(name);
      return entry && entry.value !== '' ? { name, value: entry.value } : undefined;
    },
    getAll: () => [...jar.entries()].map(([name, entry]) => ({ name, value: entry.value })),
    has: (name: string) => jar.has(name) && jar.get(name)?.value !== '',
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      jar.set(name, { value, ...(options ?? {}) });
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers({ 'user-agent': 'vitest' }),
}));
