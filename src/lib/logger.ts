import { describeError } from './errors';

/**
 * Minimal structured logger. One line of JSON per event so a container log
 * driver can parse it, with no dependency and no transport to configure.
 *
 * Secrets are redacted defensively: the Telegram bot token appears in every
 * API URL we build, so any string passing through here has it stripped.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function activeLevel(): Level {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

/** Strips anything shaped like a bot token out of arbitrary text. */
export function redact(value: string): string {
  return value
    .replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-token>');
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|cookie|authorization/i.test(k)) {
      out[k] = '<redacted>';
      continue;
    }
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

function emit(level: Level, event: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ? (scrub(fields) as Record<string, unknown>) : {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, error?: unknown, fields?: Record<string, unknown>) =>
    emit('error', event, { ...fields, error: error === undefined ? undefined : describeError(error) }),
};
