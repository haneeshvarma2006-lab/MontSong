/**
 * A stand-in for the browser's cookie jar.
 *
 * Route handlers set cookies through `next/headers`, which only works inside a
 * Next request scope. Rather than skip the parts of the flow that depend on it,
 * the tests mock `next/headers` against this jar — so a login genuinely writes
 * a session cookie, and the next request can present it and be authenticated,
 * which is the behaviour worth testing.
 */

export interface JarEntry {
  value: string;
  expires?: Date;
  httpOnly?: boolean;
  sameSite?: string;
  secure?: boolean;
  path?: string;
}

export const jar = new Map<string, JarEntry>();

export function resetJar(): void {
  jar.clear();
}

/** Serialise the jar into a Cookie request header. */
export function cookieHeader(): string {
  return [...jar.entries()]
    .filter(([, entry]) => entry.value !== '')
    .map(([name, entry]) => `${name}=${encodeURIComponent(entry.value)}`)
    .join('; ');
}

export function getCookie(name: string): string | undefined {
  const entry = jar.get(name);
  return entry && entry.value !== '' ? entry.value : undefined;
}
