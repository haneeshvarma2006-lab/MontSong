import 'server-only';

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { prisma } from '../db';
import { getConfig } from '../env';
import { logger } from '../logger';
import { createToken } from '../ids';

/**
 * On-disk media cache.
 *
 * Telegram is the durable store; this is a read-through cache in front of it,
 * and it exists for three reasons:
 *
 *  1. **Range requests.** An `<audio>` element seeks by issuing Range requests.
 *     Serving those from a local file is exact and cheap; proxying each one to
 *     Telegram would mean a `getFile` round trip and a fresh HTTPS transfer per
 *     seek, and Telegram's CDN is not contractually required to honour Range.
 *  2. **Rate limits.** A track that gets shared once can be fetched hundreds of
 *     times in an hour. Cached, that is one Telegram transfer, not hundreds.
 *  3. **Latency.** Local disk beats a round trip to Telegram's CDN.
 *
 * The cache is *not* a duplicate of the library: it is bounded by
 * MEDIA_CACHE_MAX_BYTES and evicts least-recently-used entries. Deleting the
 * whole directory is always safe — every entry can be re-fetched.
 *
 * Concurrency: `withEntry` single-flights per file, so a hundred simultaneous
 * first plays of a new track produce exactly one Telegram download.
 */

export interface CacheEntry {
  readonly path: string;
  readonly bytes: number;
}

/** In-flight fills, keyed by file_unique_id. */
const inFlight = new Map<string, Promise<CacheEntry | null>>();

function cachePathFor(fileUniqueId: string): string {
  const { dir } = getConfig().cache;
  // file_unique_id is Telegram-generated and base64url-ish. Hard-restrict it to
  // a safe alphabet anyway so it can never escape the cache directory.
  const safe = fileUniqueId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  const shard = safe.slice(0, 2).padEnd(2, '_');
  return path.join(dir, shard, safe);
}

export async function ensureCacheDir(): Promise<void> {
  await mkdir(getConfig().cache.dir, { recursive: true });
}

/**
 * Return the cached entry for a file, or null. Verifies the file is still on
 * disk (a volume can be wiped independently of the database) and refreshes the
 * LRU timestamp.
 */
export async function lookup(fileUniqueId: string): Promise<CacheEntry | null> {
  const row = await prisma.cachedFile.findUnique({ where: { fileUniqueId } });
  if (!row) return null;

  const info = await stat(row.path).catch(() => null);
  if (!info?.isFile() || info.size !== row.bytes) {
    // Stale bookkeeping — drop the row so the next request re-fills.
    await prisma.cachedFile.deleteMany({ where: { fileUniqueId } });
    return null;
  }

  // Touch asynchronously; a failed LRU update must never fail a playback.
  void prisma.cachedFile
    .update({ where: { fileUniqueId }, data: { lastAccessedAt: new Date() } })
    .catch(() => undefined);

  return { path: row.path, bytes: row.bytes };
}

/**
 * Write a stream into the cache atomically: spool to a temporary name, then
 * rename into place, so a reader never observes a half-written file.
 *
 * Returns null (and cleans up) if the write fails or the source is larger than
 * MEDIA_CACHE_MAX_FILE_BYTES — caching is an optimisation, so a failure here is
 * logged and swallowed rather than propagated to the visitor.
 */
export async function store(
  fileUniqueId: string,
  source: ReadableStream<Uint8Array>,
  expectedBytes?: number,
): Promise<CacheEntry | null> {
  const config = getConfig();
  if (expectedBytes !== undefined && expectedBytes > config.cache.maxFileBytes) {
    await source.cancel().catch(() => undefined);
    return null;
  }

  const finalPath = cachePathFor(fileUniqueId);
  const tempPath = `${finalPath}.${createToken(8)}.part`;

  await mkdir(path.dirname(finalPath), { recursive: true });

  let written = 0;
  try {
    const limit = config.cache.maxFileBytes;
    const counting = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        written += chunk.byteLength;
        if (written > limit) {
          throw new Error(`cache entry exceeded ${limit} bytes`);
        }
        controller.enqueue(chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(source.pipeThrough(counting) as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(tempPath),
    );

    // A short read must never be committed. `lookup` validates a cached file
    // against the byte count recorded here, so a truncated fill would record
    // its own truncated length, validate against itself forever, and be served
    // under the full Content-Length taken from the media row — a permanently
    // clipped track that only a manual cache purge would fix. The temporary
    // file is discarded instead, and the caller streams through from Telegram.
    if (expectedBytes !== undefined && written !== expectedBytes) {
      throw new Error(`cache fill was ${written} bytes, expected ${expectedBytes}`);
    }

    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    logger.warn('cache.store_failed', { fileUniqueId, reason: String(error) });
    return null;
  }

  await prisma.cachedFile.upsert({
    where: { fileUniqueId },
    create: { fileUniqueId, path: finalPath, bytes: written, lastAccessedAt: new Date() },
    update: { path: finalPath, bytes: written, lastAccessedAt: new Date() },
  });

  void evictIfNeeded().catch((error) => logger.warn('cache.evict_failed', { reason: String(error) }));

  return { path: finalPath, bytes: written };
}

/**
 * Look the file up, and if it is absent run `fill` exactly once even under
 * concurrent callers. Returns null when the file could not be cached, which
 * tells the caller to stream straight through from Telegram instead.
 */
export async function withEntry(
  fileUniqueId: string,
  fill: () => Promise<CacheEntry | null>,
): Promise<CacheEntry | null> {
  const existing = await lookup(fileUniqueId);
  if (existing) return existing;

  const pending = inFlight.get(fileUniqueId);
  if (pending) return pending;

  const promise = (async () => {
    try {
      // Re-check: another caller may have finished between our lookup and here.
      const raced = await lookup(fileUniqueId);
      if (raced) return raced;
      return await fill();
    } finally {
      inFlight.delete(fileUniqueId);
    }
  })();

  inFlight.set(fileUniqueId, promise);
  return promise;
}

/** Drop a single entry, both the file and its bookkeeping. */
export async function purge(fileUniqueId: string): Promise<void> {
  const row = await prisma.cachedFile.findUnique({ where: { fileUniqueId } });
  if (row) {
    await rm(row.path, { force: true }).catch(() => undefined);
    await prisma.cachedFile.deleteMany({ where: { fileUniqueId } });
  }
}

/**
 * Evict least-recently-used entries until the cache fits its budget.
 *
 * Unlinking a file that a response is still reading is safe on POSIX: the open
 * descriptor keeps the inode alive until that read finishes.
 */
export async function evictIfNeeded(): Promise<{ evicted: number; freedBytes: number }> {
  const budget = getConfig().cache.maxBytes;
  const aggregate = await prisma.cachedFile.aggregate({ _sum: { bytes: true } });
  let total = aggregate._sum.bytes ?? 0;
  if (total <= budget) return { evicted: 0, freedBytes: 0 };

  let evicted = 0;
  let freedBytes = 0;

  // Walk oldest-first in pages so a very large cache does not load entirely.
  while (total > budget) {
    const victims = await prisma.cachedFile.findMany({
      orderBy: { lastAccessedAt: 'asc' },
      take: 50,
    });
    if (victims.length === 0) break;

    for (const victim of victims) {
      await rm(victim.path, { force: true }).catch(() => undefined);
      await prisma.cachedFile.deleteMany({ where: { fileUniqueId: victim.fileUniqueId } });
      total -= victim.bytes;
      freedBytes += victim.bytes;
      evicted += 1;
      if (total <= budget) break;
    }
  }

  logger.info('cache.evicted', { evicted, freedBytes, remainingBytes: total });
  return { evicted, freedBytes };
}

export async function cacheStats(): Promise<{ files: number; bytes: number; budgetBytes: number }> {
  const [count, aggregate] = await Promise.all([
    prisma.cachedFile.count(),
    prisma.cachedFile.aggregate({ _sum: { bytes: true } }),
  ]);
  return {
    files: count,
    bytes: aggregate._sum.bytes ?? 0,
    budgetBytes: getConfig().cache.maxBytes,
  };
}

/** Remove every entry. Exposed on the admin storage screen. */
export async function clearCache(): Promise<number> {
  const rows = await prisma.cachedFile.findMany();
  for (const row of rows) {
    await rm(row.path, { force: true }).catch(() => undefined);
  }
  await prisma.cachedFile.deleteMany({});
  return rows.length;
}

/** Test-only: forget in-flight fills between cases. */
export function resetCacheStateForTests(): void {
  inFlight.clear();
}
