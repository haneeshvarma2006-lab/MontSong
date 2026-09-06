'use client';

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/constants';

/**
 * The admin UI's HTTP client.
 *
 * Two things every admin request needs, in one place so no call site can forget
 * either: the CSRF token echoed from its cookie into a header (the double-submit
 * half the server checks), and a uniform way of turning an error response into
 * something a form can display.
 */

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, string[]>;
  /** Server-side detail. Admin-only, and worth showing them — it is diagnostic. */
  readonly diagnostic?: string;
  readonly status: number;
}

export class AdminApiError extends Error {
  readonly code: string;
  readonly details?: Record<string, string[]>;
  readonly diagnostic?: string;
  readonly status: number;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'AdminApiError';
    this.code = error.code;
    this.details = error.details;
    this.diagnostic = error.diagnostic;
    this.status = error.status;
  }
}

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === CSRF_COOKIE_NAME) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

async function toError(response: Response): Promise<AdminApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const parsed =
    body !== null && typeof body === 'object' && 'error' in body
      ? (body as { error: Omit<ApiError, 'status'> }).error
      : null;

  return new AdminApiError({
    code: parsed?.code ?? 'internal_error',
    message: parsed?.message ?? `Request failed (${response.status}).`,
    details: parsed?.details,
    diagnostic: parsed?.diagnostic,
    status: response.status,
  });
}

async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);

  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const token = readCsrfToken();
    if (token) headers.set(CSRF_HEADER_NAME, token);
  }

  // FormData must set its own Content-Type so the boundary is included.
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
  });

  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => send<T>(path),
  post: <T>(path: string, body?: unknown) =>
    send<T>(path, {
      method: 'POST',
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body?: unknown) =>
    send<T>(path, {
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  delete: <T>(path: string) => send<T>(path, { method: 'DELETE' }),
};

/**
 * Upload with progress.
 *
 * `fetch` still cannot report request upload progress, and an upload of tens of
 * megabytes with no feedback feels broken. XMLHttpRequest can, so this one call
 * uses it — deliberately, and only here.
 */
export function uploadWithProgress<T>(
  path: string,
  form: FormData,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', path, true);
    request.withCredentials = true;

    const token = readCsrfToken();
    if (token) request.setRequestHeader(CSRF_HEADER_NAME, token);

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });

    request.addEventListener('load', () => {
      let body: unknown = null;
      try {
        body = JSON.parse(request.responseText) as unknown;
      } catch {
        /* a non-JSON body is handled by the status check below */
      }

      if (request.status >= 200 && request.status < 300) {
        resolve(body as T);
        return;
      }

      const parsed =
        body !== null && typeof body === 'object' && 'error' in body
          ? (body as { error: Omit<ApiError, 'status'> }).error
          : null;

      reject(
        new AdminApiError({
          code: parsed?.code ?? 'internal_error',
          message: parsed?.message ?? `Upload failed (${request.status}).`,
          details: parsed?.details,
          diagnostic: parsed?.diagnostic,
          status: request.status,
        }),
      );
    });

    request.addEventListener('error', () =>
      reject(
        new AdminApiError({
          code: 'network',
          message: 'The upload could not reach the server. Check your connection and try again.',
          status: 0,
        }),
      ),
    );

    request.addEventListener('abort', () =>
      reject(
        new AdminApiError({ code: 'aborted', message: 'Upload cancelled.', status: 0 }),
      ),
    );

    signal?.addEventListener('abort', () => request.abort(), { once: true });

    request.send(form);
  });
}
