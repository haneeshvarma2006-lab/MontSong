import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/constants';

import { cookieHeader, getCookie } from './cookie-jar';

/**
 * Request construction for route-handler tests.
 *
 * The handlers are called directly with a real `Request`, which is what Next
 * hands them in production — so these tests exercise the genuine parsing,
 * authorisation, streaming and error paths rather than a mock of them.
 */

const ORIGIN = 'http://localhost:3000';

export interface RequestOptions {
  method?: string;
  body?: BodyInit | null;
  headers?: Record<string, string>;
  /** Send the cookies currently in the jar. Defaults to true. */
  authenticated?: boolean;
  /** Echo the CSRF cookie into its header. Defaults to true for unsafe methods. */
  csrf?: boolean;
  /** Override the Origin header, to test cross-site rejection. */
  origin?: string | null;
}

export function makeRequest(path: string, options: RequestOptions = {}): Request {
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);

  if (options.authenticated !== false) {
    const cookies = cookieHeader();
    if (cookies) headers.set('cookie', cookies);
  }

  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (unsafe) {
    if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
    if (options.csrf !== false) {
      const token = getCookie(CSRF_COOKIE_NAME);
      if (token) headers.set(CSRF_HEADER_NAME, token);
    }
  }

  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: options.body ?? null,
    // Node's Request requires this for a streaming body; harmless otherwise.
    ...(options.body ? { duplex: 'half' } : {}),
  } as RequestInit);
}

export function jsonRequest(path: string, options: RequestOptions & { json?: unknown } = {}): Request {
  return makeRequest(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.json === undefined ? options.body : JSON.stringify(options.json),
  });
}

/** Route params come to a handler as a promise. */
export function params<T extends Record<string, string>>(values: T): { params: Promise<T> } {
  return { params: Promise.resolve(values) };
}

export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function readBytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}
