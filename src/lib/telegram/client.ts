import 'server-only';

import { createReadStream, openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { getConfig } from '../env';
import { AppError, storageUnavailable, internalError, describeError } from '../errors';
import { logger } from '../logger';

/**
 * Telegram Bot API client.
 *
 * ## What the Bot API can and cannot do (verified September 2026, Bot API 10)
 *
 * | capability            | cloud api.telegram.org | self-hosted --local server |
 * |-----------------------|------------------------|----------------------------|
 * | bot sends a file      | up to 50 MB            | up to 2000 MB              |
 * | bot downloads a file  | up to 20 MB (getFile)  | no size limit              |
 * | getFile link lifetime | "at least 1 hour"      | absolute local path        |
 *
 * The asymmetry is the important part. This site must serve every stored file
 * back to a visitor, so on the cloud API the *download* limit is the real
 * ceiling — a 40 MB upload would succeed and then be permanently unplayable.
 * `getConfig().uploads.maxAudioBytes` is clamped accordingly in env.ts.
 *
 * ## Rate limits
 *
 * Telegram does not publish exact numbers; the well-established practical
 * ceiling is roughly 30 messages/second overall. Any call may answer 429 with
 * `parameters.retry_after`, and the documented correct behaviour is to wait
 * that many seconds and retry. Ignoring `retry_after` escalates the cooldown,
 * so `request()` below always honours it.
 *
 * ## What this client deliberately does not do
 *
 * No MTProto, no unofficial endpoints, no scraping. Raising the file ceiling
 * beyond 20 MB is done the supported way: point TELEGRAM_API_BASE_URL at a
 * local Bot API server (github.com/tdlib/telegram-bot-api).
 */

// --- Wire types (only the fields we consume) --------------------------------

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

interface TelegramFileBase {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}

interface TelegramAudio extends TelegramFileBase {
  duration?: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
}

interface TelegramDocument extends TelegramFileBase {
  file_name?: string;
  mime_type?: string;
}

interface TelegramPhotoSize extends TelegramFileBase {
  width: number;
  height: number;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number | string };
  audio?: TelegramAudio;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
  voice?: TelegramAudio;
}

interface TelegramFile extends TelegramFileBase {
  file_path?: string;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name: string;
  can_read_all_group_messages?: boolean;
}

interface TelegramChat {
  id: number | string;
  type: string;
  title?: string;
  username?: string;
}

// --- Public shapes ----------------------------------------------------------

export interface StoredFileRef {
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly fileSize?: number;
  readonly mimeType?: string;
  readonly fileName?: string;
  readonly durationSec?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface SentMedia {
  readonly messageId: number;
  readonly chatId: string;
  readonly file: StoredFileRef;
}

export interface UploadInput {
  /** Path on local disk to the spooled upload. */
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly caption?: string;
  /** Only used by sendAudio. */
  readonly durationSec?: number;
  readonly title?: string;
  readonly performer?: string;
}

export interface DownloadHandle {
  readonly body: ReadableStream<Uint8Array>;
  /** Total size of the underlying file, when the source reported one. */
  readonly totalBytes?: number;
  /** True when the source honoured our Range request itself. */
  readonly rangeApplied: boolean;
}

export interface ConnectionReport {
  readonly ok: boolean;
  readonly bot?: { id: number; username?: string; name: string };
  readonly chat?: { id: string; type: string; title?: string };
  readonly mode: 'cloud' | 'local-server';
  readonly maxUploadBytes: number;
  readonly errors: string[];
  readonly warnings: string[];
}

// --- Client -----------------------------------------------------------------

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 400;
/** Never sleep longer than this for a 429; surface the error instead. */
const MAX_RETRY_AFTER_SECONDS = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramClient {
  readonly #token: string;
  readonly #apiBaseUrl: string;
  readonly #localMode: boolean;
  readonly #debug: boolean;
  readonly #chatId: string;

  constructor(options?: {
    token?: string;
    apiBaseUrl?: string;
    localMode?: boolean;
    chatId?: string;
    debug?: boolean;
  }) {
    const config = getConfig();
    this.#token = options?.token ?? config.telegram.botToken;
    this.#apiBaseUrl = options?.apiBaseUrl ?? config.telegram.apiBaseUrl;
    this.#localMode = options?.localMode ?? config.telegram.localMode;
    this.#chatId = options?.chatId ?? config.telegram.storageChatId;
    this.#debug = options?.debug ?? config.telegram.debug;
  }

  get chatId(): string {
    return this.#chatId;
  }

  get isLocalServer(): boolean {
    return this.#apiBaseUrl !== 'https://api.telegram.org';
  }

  /** Method endpoint. Never logged verbatim — it embeds the bot token. */
  #methodUrl(method: string): string {
    return `${this.#apiBaseUrl}/bot${this.#token}/${method}`;
  }

  #fileUrl(filePath: string): string {
    return `${this.#apiBaseUrl}/file/bot${this.#token}/${filePath}`;
  }

  /**
   * Perform one Bot API call, retrying on 429 (honouring `retry_after`), on
   * 5xx, and on transport failures. Deliberately does *not* retry 4xx other
   * than 429: a malformed request will not become well-formed.
   */
  async request<T>(method: string, body?: BodyInit, extraHeaders?: HeadersInit): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const startedAt = Date.now();
      let response: Response;

      try {
        response = await fetch(this.#methodUrl(method), {
          method: 'POST',
          body,
          headers: extraHeaders,
          // Uploads can legitimately take minutes on a slow link; the caller
          // controls the overall deadline via its own AbortSignal if needed.
          signal: AbortSignal.timeout(10 * 60 * 1000),
        });
      } catch (error) {
        lastError = error;
        // A streamed body cannot be replayed, so a failed upload must not be
        // retried here — the caller re-spools instead.
        if (body instanceof FormData) {
          throw storageUnavailable('Could not reach the media storage service.', {
            internal: describeError(error),
            cause: error,
          });
        }
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      let payload: TelegramResponse<T>;
      try {
        payload = (await response.json()) as TelegramResponse<T>;
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS || response.status < 500) {
          // The API always answers JSON, even for its own errors. Anything
          // else means we never reached it: a proxy, firewall, captive portal
          // or ISP landing page answered in its place. Saying "unreadable
          // response" sends the owner hunting for a credential problem that
          // is not there, so name the actual class of failure instead.
          throw storageUnavailable(intercepted(response), {
            internal:
              `status=${response.status} content-type=${response.headers.get('content-type') ?? 'none'}`,
            cause: error,
          });
        }
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      if (this.#debug) {
        logger.debug('telegram.call', {
          method,
          status: response.status,
          ok: payload.ok,
          ms: Date.now() - startedAt,
        });
      }

      if (payload.ok && payload.result !== undefined) {
        return payload.result;
      }

      const description = payload.description ?? `HTTP ${response.status}`;

      if (response.status === 429) {
        const retryAfter = payload.parameters?.retry_after ?? 1;
        if (retryAfter > MAX_RETRY_AFTER_SECONDS || attempt === MAX_ATTEMPTS) {
          throw new AppError('rate_limited', 'The media storage service is busy. Try again shortly.', {
            retryAfterSeconds: retryAfter,
            internal: description,
          });
        }
        logger.warn('telegram.rate_limited', { method, retryAfter, attempt });
        await sleep(retryAfter * 1000);
        continue;
      }

      if (response.status >= 500) {
        lastError = new Error(description);
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      // Deterministic 4xx — surface a useful message without leaking the token.
      throw mapTelegramError(response.status, description);
    }

    throw storageUnavailable('The media storage service is unavailable. Try again in a moment.', {
      internal: describeError(lastError),
      cause: lastError,
    });
  }

  // --- Health ---------------------------------------------------------------

  async getMe(): Promise<TelegramUser> {
    return this.request<TelegramUser>('getMe', formOf({}));
  }

  async getChat(): Promise<TelegramChat> {
    return this.request<TelegramChat>('getChat', formOf({ chat_id: this.#chatId }));
  }

  /**
   * End-to-end connectivity check for the admin "Storage" screen: the token is
   * valid, the storage chat exists, and the bot can post into it.
   */
  async testConnection(): Promise<ConnectionReport> {
    const config = getConfig();
    const errors: string[] = [];
    const warnings: string[] = [];
    let bot: ConnectionReport['bot'];
    let chat: ConnectionReport['chat'];

    try {
      const me = await this.getMe();
      bot = { id: me.id, username: me.username, name: me.first_name };
    } catch (error) {
      errors.push(`getMe failed: ${publicMessage(error)}`);
    }

    if (bot) {
      try {
        const info = await this.getChat();
        chat = { id: String(info.id), type: info.type, title: info.title };
        if (info.type === 'private') {
          warnings.push(
            'The storage chat is a private chat. A private channel is recommended so the ' +
              'library survives the owner clearing their chat history.',
          );
        }
      } catch (error) {
        errors.push(
          `getChat failed: ${publicMessage(error)}. Check that TELEGRAM_STORAGE_CHAT_ID is correct ` +
            'and that the bot is a member (and admin) of that chat.',
        );
      }
    }

    return {
      ok: errors.length === 0,
      bot,
      chat,
      mode: this.isLocalServer ? 'local-server' : 'cloud',
      maxUploadBytes: config.uploads.maxAudioBytes,
      errors,
      warnings,
    };
  }

  // --- Upload ---------------------------------------------------------------

  /**
   * Store an audio file.
   *
   * MP3 and M4A go through `sendAudio`, which makes Telegram parse the track's
   * own metadata (duration in particular) and store it alongside the file.
   * Every other accepted format goes through `sendDocument`, which stores the
   * bytes untouched — `sendAudio` is documented as expecting .MP3/.M4A and can
   * reject or reinterpret anything else.
   *
   * The file is read lazily from disk via `openAsBlob`, so a 2 GB upload on a
   * local Bot API server costs a socket buffer, not 2 GB of heap.
   */
  async uploadAudio(input: UploadInput): Promise<SentMedia> {
    const usesSendAudio = input.mimeType === 'audio/mpeg' || input.mimeType === 'audio/mp4';
    return usesSendAudio ? this.#sendAudio(input) : this.#sendDocument(input);
  }

  async uploadImage(input: UploadInput): Promise<SentMedia> {
    const form = await this.#mediaForm('photo', input);
    const message = await this.request<TelegramMessage>('sendPhoto', form);

    const sizes = message.photo ?? [];
    const largest = sizes.reduce<TelegramPhotoSize | undefined>(
      (best, size) => (!best || size.width * size.height > best.width * best.height ? size : best),
      undefined,
    );

    if (!largest) {
      // sendPhoto answered ok but without a photo array; treat as a storage
      // fault rather than silently recording a file we cannot fetch back.
      throw storageUnavailable('The media storage service accepted the image but returned no file.', {
        internal: JSON.stringify(message).slice(0, 500),
      });
    }

    return {
      messageId: message.message_id,
      chatId: String(message.chat.id),
      file: {
        fileId: largest.file_id,
        fileUniqueId: largest.file_unique_id,
        fileSize: largest.file_size,
        mimeType: 'image/jpeg', // Telegram re-encodes photos to JPEG.
        fileName: input.fileName,
        width: largest.width,
        height: largest.height,
      },
    };
  }

  async #sendAudio(input: UploadInput): Promise<SentMedia> {
    const form = await this.#mediaForm('audio', input);
    if (input.durationSec !== undefined) form.set('duration', String(Math.round(input.durationSec)));
    if (input.title) form.set('title', input.title.slice(0, 128));
    if (input.performer) form.set('performer', input.performer.slice(0, 128));

    const message = await this.request<TelegramMessage>('sendAudio', form);
    const audio = message.audio ?? message.document;
    if (!audio) {
      throw storageUnavailable('The media storage service accepted the file but returned no audio.', {
        internal: JSON.stringify(message).slice(0, 500),
      });
    }

    return {
      messageId: message.message_id,
      chatId: String(message.chat.id),
      file: {
        fileId: audio.file_id,
        fileUniqueId: audio.file_unique_id,
        fileSize: audio.file_size,
        mimeType: audio.mime_type ?? input.mimeType,
        fileName: audio.file_name ?? input.fileName,
        durationSec: durationOf(audio),
      },
    };
  }

  async #sendDocument(input: UploadInput): Promise<SentMedia> {
    const form = await this.#mediaForm('document', input);
    // Documents keep their exact bytes; suppress Telegram's own thumbnailing.
    form.set('disable_content_type_detection', 'true');

    const message = await this.request<TelegramMessage>('sendDocument', form);
    const doc = message.document ?? message.audio;
    if (!doc) {
      throw storageUnavailable('The media storage service accepted the file but returned no document.', {
        internal: JSON.stringify(message).slice(0, 500),
      });
    }

    return {
      messageId: message.message_id,
      chatId: String(message.chat.id),
      file: {
        fileId: doc.file_id,
        fileUniqueId: doc.file_unique_id,
        fileSize: doc.file_size,
        mimeType: doc.mime_type ?? input.mimeType,
        fileName: doc.file_name ?? input.fileName,
        durationSec: durationOf(doc),
      },
    };
  }

  async #mediaForm(field: string, input: UploadInput): Promise<FormData> {
    const info = await stat(input.filePath);
    if (!info.isFile() || info.size === 0) {
      throw internalError('The spooled upload disappeared before it could be stored.', {
        internal: input.filePath,
      });
    }

    const blob = await openAsBlob(input.filePath, { type: input.mimeType });
    const form = new FormData();
    form.set('chat_id', this.#chatId);
    form.set(field, blob, input.fileName);
    if (input.caption) form.set('caption', input.caption.slice(0, 1024));
    form.set('disable_notification', 'true');
    return form;
  }

  // --- Retrieval ------------------------------------------------------------

  /**
   * Resolve a file_id to a path. On the cloud API this is a relative path to
   * be appended to the file download URL; with a local Bot API server started
   * with `--local` it is an absolute path on this machine.
   */
  async getFilePath(fileId: string): Promise<{ filePath: string; fileSize?: number }> {
    const file = await this.request<TelegramFile>('getFile', formOf({ file_id: fileId }));
    if (!file.file_path) {
      throw storageUnavailable('The media storage service did not return a location for this file.');
    }
    return { filePath: file.file_path, fileSize: file.file_size };
  }

  /**
   * Open a byte stream for a resolved file path.
   *
   * `range` is passed through to Telegram when possible. Telegram's file CDN
   * usually honours Range, but it is not contractual, so the caller is told via
   * `rangeApplied` whether it did — see media/serve.ts, which slices the stream
   * itself when it did not.
   */
  async openFile(
    filePath: string,
    options: { range?: { start: number; end: number }; signal?: AbortSignal } = {},
  ): Promise<DownloadHandle> {
    if (this.#localMode) {
      return this.#openLocalFile(filePath, options.range);
    }

    const headers = new Headers();
    if (options.range) {
      headers.set('Range', `bytes=${options.range.start}-${options.range.end}`);
    }

    let response: Response;
    try {
      response = await fetch(this.#fileUrl(filePath), {
        headers,
        signal: options.signal,
        // Files are immutable in Telegram; let the platform cache negotiate.
        cache: 'no-store',
      });
    } catch (error) {
      // A cancelled download is not an outage. Dressing an abort up as
      // `storage_unavailable` put "Could not reach the media storage service"
      // in the log every time somebody skipped a track, which buries the real
      // outages among thousands of ordinary ones. Let it through as itself.
      if (options.signal?.aborted) throw error;

      throw storageUnavailable('Could not reach the media storage service.', {
        internal: describeError(error),
        cause: error,
      });
    }

    if (!response.ok && response.status !== 206) {
      // Drain so the socket returns to the pool.
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404 || response.status === 410) {
        throw storageUnavailable(
          'This file is no longer available from storage. It may need to be re-uploaded.',
          { internal: `file download status ${response.status}` },
        );
      }
      throw storageUnavailable('The media storage service could not return this file.', {
        internal: `file download status ${response.status}`,
      });
    }

    if (!response.body) {
      throw storageUnavailable('The media storage service returned an empty file.');
    }

    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    const totalFromRange = contentRange ? Number(contentRange.split('/')[1]) : Number.NaN;

    return {
      body: response.body,
      totalBytes: Number.isFinite(totalFromRange)
        ? totalFromRange
        : contentLength
          ? Number(contentLength)
          : undefined,
      rangeApplied: response.status === 206,
    };
  }

  async #openLocalFile(
    filePath: string,
    range?: { start: number; end: number },
  ): Promise<DownloadHandle> {
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      throw storageUnavailable('This file is no longer available from local storage.', {
        internal: filePath,
      });
    }
    const nodeStream = createReadStream(
      filePath,
      range ? { start: range.start, end: range.end } : undefined,
    );
    return {
      body: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      totalBytes: info.size,
      rangeApplied: range !== undefined,
    };
  }

  /**
   * Remove the message backing a deleted track. Best effort: Telegram refuses
   * for messages the bot is not allowed to delete, and a leftover message in a
   * private channel is not worth failing a user-facing delete over.
   */
  async deleteMessage(messageId: number): Promise<boolean> {
    try {
      await this.request<boolean>(
        'deleteMessage',
        formOf({ chat_id: this.#chatId, message_id: String(messageId) }),
      );
      return true;
    } catch (error) {
      logger.warn('telegram.delete_failed', { messageId, reason: publicMessage(error) });
      return false;
    }
  }
}

// --- Helpers ----------------------------------------------------------------

/**
 * sendAudio reports a duration; sendDocument does not. Both come back through
 * the same union, so read it defensively rather than narrowing on a key that
 * one branch does not declare.
 */
function durationOf(file: TelegramAudio | TelegramDocument): number | undefined {
  const value = (file as TelegramAudio).duration;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Describe a response that was not JSON.
 *
 * The Bot API answers JSON for every outcome including its own errors, so a
 * non-JSON body means the request never arrived: something on the path
 * answered instead. The status narrows which something. Kept free of any
 * mention of the backend — these messages can surface outside the admin.
 */
function intercepted(response: Response): string {
  if (response.status === 407 || response.status === 511) {
    return 'A network proxy demanded authentication before it would pass the request to the media storage service. Check this server’s proxy settings.';
  }
  if (response.status === 403 || response.status === 451) {
    return 'A network proxy or firewall refused to pass the request to the media storage service. Check that this server is allowed to make outbound HTTPS requests to it.';
  }
  return `Could not reach the media storage service: something on the network answered in its place (HTTP ${response.status}). Check this server’s internet access, DNS, and any proxy or firewall in between.`;
}

function formOf(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

function publicMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return 'unexpected error';
}

/**
 * Translate a Telegram 4xx into something an admin can act on. The raw
 * description is kept as `internal` so it reaches the admin diagnostics but
 * never a public response.
 */
export function mapTelegramError(status: number, description: string): AppError {
  const lower = description.toLowerCase();

  if (lower.includes('file is too big')) {
    return new AppError(
      'file_too_large_for_telegram',
      'This file is larger than the media storage service will hand back (20 MB on the cloud ' +
        'Bot API). Re-encode it, or run a local Bot API server — see docs/TELEGRAM_SETUP.md.',
      { internal: description },
    );
  }
  if (lower.includes('request entity too large') || lower.includes('too large')) {
    return new AppError('payload_too_large', 'This file is too large for the media storage service.', {
      internal: description,
    });
  }
  if (lower.includes('chat not found')) {
    return storageUnavailable(
      'The configured storage chat could not be found. Check TELEGRAM_STORAGE_CHAT_ID and that ' +
        'the bot has been added to that chat.',
      { internal: description },
    );
  }
  if (lower.includes('not enough rights') || lower.includes('have no rights')) {
    return storageUnavailable(
      'The bot does not have permission to post in the storage chat. Make it an administrator ' +
        'with permission to post messages.',
      { internal: description },
    );
  }
  if (lower.includes('unauthorized')) {
    return storageUnavailable(
      'The media storage credentials were rejected. Check TELEGRAM_BOT_TOKEN.',
      { internal: description },
    );
  }

  return storageUnavailable('The media storage service rejected the request.', {
    internal: `status=${status} ${description}`,
  });
}

let shared: TelegramClient | null = null;

export function getTelegramClient(): TelegramClient {
  shared ??= new TelegramClient();
  return shared;
}

/** Test-only. */
export function resetTelegramClientForTests(): void {
  shared = null;
}
