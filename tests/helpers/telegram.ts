import { vi } from 'vitest';

/**
 * A stand-in for the Telegram Bot API.
 *
 * Real Telegram is not reachable from a test run, and pointing the suite at it
 * would be slow, rate-limited and would litter a real channel. This fake speaks
 * the same wire protocol: the same JSON envelope, the same error shapes, the
 * same `getFile` two-step, and the same file download URL — so the client under
 * test exercises all of its real parsing, retry and error-mapping paths.
 *
 * It also lets a test *choose* a failure: a 429 with retry_after, a "file is
 * too big" 400, a network drop mid-upload. Those are the paths that matter and
 * the ones that are impossible to trigger reliably against the real service.
 */

export interface StoredFile {
  fileId: string;
  fileUniqueId: string;
  filePath: string;
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  messageId: number;
}

export interface FakeTelegramOptions {
  /** Force the next N calls to a given method to fail this way. */
  failures?: Partial<Record<string, { status: number; description: string; retryAfter?: number }[]>>;
  /** Throw a transport error instead of answering. */
  offline?: boolean;
}

export class FakeTelegram {
  readonly files = new Map<string, StoredFile>();
  readonly calls: { method: string; body?: unknown }[] = [];
  readonly deletedMessages: number[] = [];

  #nextMessageId = 1000;
  #counter = 0;
  #options: FakeTelegramOptions;

  constructor(options: FakeTelegramOptions = {}) {
    this.#options = options;
  }

  configure(options: FakeTelegramOptions): void {
    this.#options = options;
  }

  reset(): void {
    this.files.clear();
    this.calls.length = 0;
    this.deletedMessages.length = 0;
    this.#options = {};
  }

  /** Look up a stored file by the name it was uploaded under. */
  findByName(fileName: string): StoredFile | undefined {
    return [...this.files.values()].find((file) => file.fileName === fileName);
  }

  #takeFailure(method: string) {
    const queue = this.#options.failures?.[method];
    if (!queue || queue.length === 0) return null;
    return queue.shift() ?? null;
  }

  #ok(result: unknown): Response {
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  #error(status: number, description: string, retryAfter?: number): Response {
    return new Response(
      JSON.stringify({
        ok: false,
        error_code: status,
        description,
        ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}),
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }

  async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (this.#options.offline) {
      throw new TypeError('fetch failed');
    }

    // --- File download: /file/bot<token>/<path> ---
    const downloadMatch = /\/file\/bot[^/]+\/(.+)$/.exec(url);
    if (downloadMatch) {
      return this.#serveFile(decodeURIComponent(downloadMatch[1] ?? ''), init);
    }

    // --- Method call: /bot<token>/<method> ---
    const methodMatch = /\/bot[^/]+\/([A-Za-z]+)$/.exec(url);
    if (!methodMatch) {
      return this.#error(404, 'Not Found');
    }

    const method = methodMatch[1] ?? '';
    const body = init?.body instanceof FormData ? init.body : undefined;
    this.calls.push({ method, body: body ? formToObject(body) : undefined });

    const failure = this.#takeFailure(method);
    if (failure) {
      return this.#error(failure.status, failure.description, failure.retryAfter);
    }

    switch (method) {
      case 'getMe':
        return this.#ok({ id: 42, is_bot: true, first_name: 'MontSong Bot', username: 'montsong_bot' });

      case 'getChat':
        return this.#ok({ id: -1009999999999, type: 'channel', title: 'MontSong Storage' });

      case 'sendAudio':
        return this.#store(body, 'audio');

      case 'sendDocument':
        return this.#store(body, 'document');

      case 'sendPhoto':
        return this.#store(body, 'photo');

      case 'getFile': {
        const fileId = String(body?.get('file_id') ?? '');
        const file = this.files.get(fileId);
        if (!file) return this.#error(400, 'Bad Request: file not found');
        return this.#ok({
          file_id: file.fileId,
          file_unique_id: file.fileUniqueId,
          file_size: file.bytes.byteLength,
          file_path: file.filePath,
        });
      }

      case 'deleteMessage': {
        const messageId = Number(body?.get('message_id'));
        this.deletedMessages.push(messageId);
        return this.#ok(true);
      }

      default:
        return this.#error(404, `Not Found: method not found (${method})`);
    }
  }

  async #store(body: FormData | undefined, kind: 'audio' | 'document' | 'photo'): Promise<Response> {
    const field = kind === 'photo' ? 'photo' : kind;
    const blob = body?.get(field);

    if (!(blob instanceof Blob)) {
      return this.#error(400, 'Bad Request: there is no media in the request');
    }

    const bytes = Buffer.from(await blob.arrayBuffer());
    this.#counter += 1;
    const fileId = `FILE_ID_${this.#counter}`;
    const fileUniqueId = `UNIQ${this.#counter}`;
    const fileName = (blob as File).name ?? `file-${this.#counter}`;
    const messageId = (this.#nextMessageId += 1);

    const stored: StoredFile = {
      fileId,
      fileUniqueId,
      filePath: `music/file_${this.#counter}`,
      bytes,
      mimeType: blob.type || 'application/octet-stream',
      fileName,
      messageId,
    };
    this.files.set(fileId, stored);

    const chat = { id: -1009999999999 };
    const base = {
      file_id: fileId,
      file_unique_id: fileUniqueId,
      file_size: bytes.byteLength,
      file_name: fileName,
      mime_type: stored.mimeType,
    };

    if (kind === 'photo') {
      return this.#ok({
        message_id: messageId,
        chat,
        photo: [
          { ...base, width: 320, height: 320, file_size: Math.floor(bytes.byteLength / 2) },
          { ...base, width: 1280, height: 1280 },
        ],
      });
    }

    if (kind === 'audio') {
      const duration = Number(body?.get('duration'));
      return this.#ok({
        message_id: messageId,
        chat,
        audio: { ...base, ...(Number.isFinite(duration) ? { duration } : {}) },
      });
    }

    return this.#ok({ message_id: messageId, chat, document: base });
  }

  /** Serve a stored file, honouring Range the way Telegram's CDN does. */
  #serveFile(filePath: string, init?: RequestInit): Response {
    const file = [...this.files.values()].find((candidate) => candidate.filePath === filePath);
    if (!file) {
      return new Response('Not Found', { status: 404 });
    }

    const rangeHeader = new Headers(init?.headers).get('range');
    if (!rangeHeader) {
      return new Response(new Uint8Array(file.bytes), {
        status: 200,
        headers: {
          'content-type': file.mimeType,
          'content-length': String(file.bytes.byteLength),
        },
      });
    }

    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    const start = Number(match?.[1] ?? 0);
    const end = match?.[2] ? Number(match[2]) : file.bytes.byteLength - 1;
    const slice = file.bytes.subarray(start, end + 1);

    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: {
        'content-type': file.mimeType,
        'content-length': String(slice.byteLength),
        'content-range': `bytes ${start}-${end}/${file.bytes.byteLength}`,
      },
    });
  }
}

function formToObject(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    out[key] = value instanceof Blob ? `<blob ${value.size} bytes>` : value;
  }
  return out;
}

/**
 * Install the fake as the global fetch. Requests that are not aimed at Telegram
 * are rejected loudly rather than silently passing through — a test that starts
 * making real network calls should fail, not hang.
 */
export function installFakeTelegram(fake: FakeTelegram): () => void {
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('api.telegram.org')) {
      throw new Error(`Unexpected network call in tests: ${url}`);
    }
    return fake.handle(input, init);
  }) as unknown as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}
