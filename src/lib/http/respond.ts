import 'server-only';

import { AppError, describeError, isAppError } from '../errors';
import { logger } from '../logger';

/**
 * JSON response helpers and the single place where a thrown error becomes an
 * HTTP response.
 *
 * The rule enforced here: a public caller learns *what* went wrong in ordinary
 * language and nothing else. Stack traces, Telegram descriptions, SQL text and
 * file paths are logged and, for an authenticated admin, attached under
 * `diagnostic` — never sent to an anonymous visitor.
 */

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, string[]>;
    /** Admin-only. Absent for public callers. */
    readonly diagnostic?: string;
  };
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function json<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: { ...NO_STORE, ...init?.headers },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: NO_STORE });
}

/**
 * Convert any thrown value into a Response.
 *
 * `audience` decides how much detail leaves the server: `admin` gets the
 * internal diagnostic string, `public` gets only the safe message.
 */
export function errorResponse(
  error: unknown,
  context: { route: string; audience: 'public' | 'admin' },
): Response {
  const appError = isAppError(error)
    ? error
    : new AppError('internal_error', 'Something went wrong on our end.', { cause: error });

  if (appError.status >= 500) {
    logger.error('http.error', error, { route: context.route, code: appError.code });
  } else {
    logger.warn('http.rejected', {
      route: context.route,
      code: appError.code,
      status: appError.status,
      message: appError.message,
    });
  }

  const headers: Record<string, string> = { ...NO_STORE };
  if (appError.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(appError.retryAfterSeconds);
  }

  const body: ApiErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
      ...(context.audience === 'admin'
        ? {
            diagnostic:
              appError.internal !== undefined
                ? typeof appError.internal === 'string'
                  ? appError.internal
                  : JSON.stringify(appError.internal)
                : describeError(error),
          }
        : {}),
    },
  };

  return Response.json(body, { status: appError.status, headers });
}

/**
 * Wrap a route handler so every escaping error becomes a well-formed response.
 * Handlers stay free to `throw notFound()` instead of threading Responses.
 */
export function route(
  name: string,
  audience: 'public' | 'admin',
  handler: (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>,
) {
  return async (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<Response> => {
    try {
      return await handler(request, context);
    } catch (error) {
      return errorResponse(error, { route: name, audience });
    }
  };
}
