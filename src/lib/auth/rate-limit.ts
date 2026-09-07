/**
 * In-process rate limiting.
 *
 * A fixed-capacity token bucket per key, swept lazily. Deliberately in-memory:
 * this application is designed to run as a single long-lived Node process
 * (see docs/DEPLOYMENT.md), so an in-memory limiter is exact, costs nothing,
 * and adds no infrastructure. If the deployment ever grows to more than one
 * instance, this is the module to swap for a shared store — every caller goes
 * through `consume`.
 */

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the next token is available. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitRule {
  /** Maximum burst. */
  readonly capacity: number;
  /** Tokens replenished per second. */
  readonly refillPerSecond: number;
}

/** Login: 5 attempts, refilling one every 30 seconds. */
export const LOGIN_RULE: RateLimitRule = { capacity: 5, refillPerSecond: 1 / 30 };
/** Admin writes: generous, but enough to stop a runaway script. */
export const ADMIN_WRITE_RULE: RateLimitRule = { capacity: 60, refillPerSecond: 1 };
/** Uploads: 10 in a burst, one new slot every 6 seconds. */
export const UPLOAD_RULE: RateLimitRule = { capacity: 10, refillPerSecond: 1 / 6 };
/** Public reads that touch Telegram (stream/download). */
export const MEDIA_RULE: RateLimitRule = { capacity: 120, refillPerSecond: 4 };
/** Public search. */
export const SEARCH_RULE: RateLimitRule = { capacity: 40, refillPerSecond: 2 };

const buckets = new Map<string, Bucket>();

/** Keep the map from growing without bound on a long-running process. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    // A bucket untouched for an hour is certainly full again.
    if (now - bucket.updatedAt > 60 * 60 * 1000) buckets.delete(key);
  }
}

export function consume(key: string, rule: RateLimitRule, cost = 1): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  const bucket: Bucket = existing ?? { tokens: rule.capacity, updatedAt: now };

  if (existing) {
    const elapsedSeconds = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(rule.capacity, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
    bucket.updatedAt = now;
  }

  if (bucket.tokens >= cost) {
    bucket.tokens -= cost;
    buckets.set(key, bucket);
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
  }

  buckets.set(key, bucket);
  const deficit = cost - bucket.tokens;
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil(deficit / rule.refillPerSecond)),
  };
}

/** Give a key its tokens back — used after a *successful* login. */
export function reset(key: string): void {
  buckets.delete(key);
}

/** Test-only. */
export function resetAllRateLimits(): void {
  buckets.clear();
  lastSweep = Date.now();
}
