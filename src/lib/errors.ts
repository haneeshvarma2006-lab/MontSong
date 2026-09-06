/**
 * Application error taxonomy.
 *
 * Every error that can reach an HTTP boundary carries a stable machine code,
 * an HTTP status, and a message that is safe to show a member of the public.
 * Anything else — a stack trace, a Telegram response body, a SQL error — stays
 * on the server and is only ever surfaced through the admin diagnostics API.
 */

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'storage_unavailable'
  | 'file_too_large_for_telegram'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  storage_unavailable: 503,
  file_too_large_for_telegram: 413,
  internal_error: 500,
};

export interface AppErrorOptions {
  /** Structured field errors, safe to return to an authenticated admin. */
  readonly details?: Record<string, string[]>;
  /** Seconds the client should wait before retrying (429/503). */
  readonly retryAfterSeconds?: number;
  /** Server-side only context. Logged, never serialised to a public client. */
  readonly internal?: unknown;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, string[]>;
  readonly retryAfterSeconds?: number;
  readonly internal?: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.internal = options.internal;
  }
}

export const badRequest = (m: string, o?: AppErrorOptions) => new AppError('bad_request', m, o);
export const validationFailed = (m: string, o?: AppErrorOptions) =>
  new AppError('validation_failed', m, o);
export const unauthorized = (m = 'Sign in to continue.', o?: AppErrorOptions) =>
  new AppError('unauthorized', m, o);
export const forbidden = (m = 'You do not have access to this.', o?: AppErrorOptions) =>
  new AppError('forbidden', m, o);
export const notFound = (m = 'Not found.', o?: AppErrorOptions) => new AppError('not_found', m, o);
export const conflict = (m: string, o?: AppErrorOptions) => new AppError('conflict', m, o);
export const payloadTooLarge = (m: string, o?: AppErrorOptions) =>
  new AppError('payload_too_large', m, o);
export const unsupportedMediaType = (m: string, o?: AppErrorOptions) =>
  new AppError('unsupported_media_type', m, o);
export const rateLimited = (m: string, retryAfterSeconds: number, o?: AppErrorOptions) =>
  new AppError('rate_limited', m, { ...o, retryAfterSeconds });
export const storageUnavailable = (m: string, o?: AppErrorOptions) =>
  new AppError('storage_unavailable', m, o);
export const internalError = (m = 'Something went wrong on our end.', o?: AppErrorOptions) =>
  new AppError('internal_error', m, o);

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Reduce an unknown thrown value to a single-line string for logs. Never
 * returned to a public client.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause ? ` (cause: ${describeError(error.cause)})` : '';
    return `${error.name}: ${error.message}${cause}`;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
