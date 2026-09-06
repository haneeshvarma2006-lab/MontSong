import 'server-only';

import fs from 'node:fs';
import path from 'node:path';

import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

import { PrismaClient } from '@/generated/prisma';
import { logger } from './logger';

/**
 * Prisma client singleton.
 *
 * Next.js hot-reloads server modules in development, which would otherwise
 * open a new SQLite handle on every edit until the process runs out of file
 * descriptors, so the instance is parked on globalThis.
 *
 * SQLite pragmas worth knowing about, applied by better-sqlite3 below:
 *   journal_mode=WAL  — readers never block the writer, which matters because
 *                       a stream request updates cache bookkeeping while a
 *                       page render is reading.
 *   busy_timeout      — waits instead of throwing SQLITE_BUSY under contention.
 *   foreign_keys=ON   — SQLite disables FK enforcement by default; our
 *                       onDelete rules depend on it.
 */

/** Turn a Prisma `file:` URL into an absolute filesystem path. */
export function resolveDatabaseFile(url: string): string {
  const withoutScheme = url.startsWith('file:') ? url.slice('file:'.length) : url;
  if (withoutScheme === ':memory:') return withoutScheme;
  // A runtime data path, not a module specifier — see the note in env.ts.
  return path.isAbsolute(withoutScheme)
    ? withoutScheme
    : path.resolve(/* turbopackIgnore: true */ process.cwd(), withoutScheme);
}

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL ?? 'file:./data/montsong.db';
  const file = resolveDatabaseFile(url);

  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const adapter = new PrismaBetterSqlite3({
    url: file === ':memory:' ? ':memory:' : file,
  });

  const client = new PrismaClient({
    adapter,
    log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

  return client;
}

const globalForPrisma = globalThis as unknown as { __montsongPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__montsongPrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__montsongPrisma = prisma;
}

let pragmasApplied = false;

/**
 * Apply connection pragmas. Called lazily from the app's first database touch
 * rather than at import time so that importing this module stays side-effect
 * free for tests.
 */
export async function ensurePragmas(): Promise<void> {
  if (pragmasApplied) return;
  pragmasApplied = true;
  try {
    await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL;');
    await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000;');
    await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
    await prisma.$executeRawUnsafe('PRAGMA synchronous = NORMAL;');
  } catch (error) {
    logger.warn('db.pragmas_failed', { error: String(error) });
  }
}
