import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/lib/errors';
import { TelegramClient } from '@/lib/telegram/client';

/**
 * The Bot API answers JSON for every outcome, including its own errors. So a
 * non-JSON body never came from it: a proxy, firewall, captive portal or ISP
 * landing page answered instead. These cases were previously all reported as
 * "returned an unreadable response", which reads like a backend fault and
 * sends the owner looking for a credential problem that is not there.
 */

const client = () =>
  new TelegramClient({
    token: 'test-token',
    apiBaseUrl: 'https://api.telegram.org',
    chatId: '-100123',
  });

function respondWith(status: number, body: string, contentType = 'text/html') {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(body, { status, headers: { 'content-type': contentType } }),
    );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a non-JSON reply is reported as a network interception', () => {
  it('names a refusing proxy or firewall on 403', async () => {
    respondWith(403, '<html>Forbidden by policy</html>');

    const error = await client()
      .getMe()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    const message = (error as AppError).message;
    expect(message).toMatch(/proxy or firewall/i);
    expect(message).toMatch(/outbound HTTPS/i);
    expect(message).not.toMatch(/unreadable/i);
  });

  it('names proxy authentication on 407', async () => {
    respondWith(407, 'Proxy Authentication Required', 'text/plain');

    const error = await client()
      .getMe()
      .catch((e: unknown) => e);

    expect((error as AppError).message).toMatch(/proxy.*authentication/i);
  });

  it('falls back to a general reachability message on any other status', async () => {
    respondWith(200, '<html>Captive portal, please sign in</html>');

    const error = await client()
      .getMe()
      .catch((e: unknown) => e);

    const message = (error as AppError).message;
    expect(message).toMatch(/something on the network answered in its place/i);
    expect(message).toMatch(/HTTP 200/);
  });

  it('never names the storage backend in a message that can reach the public', async () => {
    for (const status of [403, 407, 502]) {
      respondWith(status, '<html>nope</html>');
      const error = await client()
        .getMe()
        .catch((e: unknown) => e);
      expect((error as AppError).message).not.toMatch(/telegram/i);
      vi.restoreAllMocks();
    }
  });

  it('keeps the status and content-type as server-only diagnostics', async () => {
    respondWith(403, '<html>nope</html>');

    const error = (await client()
      .getMe()
      .catch((e: unknown) => e)) as AppError;

    expect(error.internal).toBe('status=403 content-type=text/html');
    expect(error.code).toBe('storage_unavailable');
  });

  it('does not retry a deterministic interception', async () => {
    const spy = respondWith(403, '<html>nope</html>');

    await client()
      .getMe()
      .catch(() => undefined);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
