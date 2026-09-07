import 'server-only';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { getConfig } from '../env';
import { logger } from '../logger';
import { openMedia } from '../telegram/storage';
import * as cache from './cache';
import { contentRangeHeader, parseRange, rangeLength, type ByteRange } from './range';

import type { MediaFile } from '@/generated/prisma';

/**
 * Turns a stored file into an HTTP response.
 *
 * This is the module that makes Telegram invisible. Nothing it returns
 * references Telegram: no redirect, no `api.telegram.org` URL, no file_id in a
 * header. The visitor's browser talks to this origin and only this origin.
 *
 * Serving strategy, in order of preference:
 *
 *  1. **Cached on disk** — stream the exact byte range straight off the volume.
 *  2. **Not cached, and small enough to cache** — fill the cache once (shared
 *     between every concurrent request for that file), then serve from disk.
 *     One Telegram transfer, and every subsequent request and every seek is
 *     local.
 *  3. **Too large to cache, or the fill failed** — proxy the bytes through from
 *     Telegram, applying the requested range ourselves if Telegram's CDN chose
 *     not to honour it.
 *
 * At no point is a whole file held in memory: every path is a stream.
 */

export interface ServeOptions {
  readonly media: MediaFile;
  readonly request: Request;
  readonly disposition: 'inline' | 'attachment';
  /** Filename offered to the browser. Required for `attachment`. */
  readonly downloadName?: string;
  /** Defaults to a day of shared caching. */
  readonly cacheControl?: string;
}

const DEFAULT_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

export async function serveMedia(options: ServeOptions): Promise<Response> {
  const { media, request } = options;
  const size = media.fileSize;

  // Telegram files are immutable, so a strong validator over the stored
  // identity and size lets a repeat visitor skip the transfer entirely.
  //
  // Hashed rather than used directly. The identifier cannot be used to fetch
  // anything without the bot token, so emitting it raw was not exploitable —
  // but this project's claim is that no storage identifier appears in any
  // public response, and an ETag is about as public as a header gets. A digest
  // keeps the validator stable and immutable while making the header say
  // nothing about where the file lives.
  const etag = `"${createHash('sha256')
    .update(`${media.telegramFileUniqueId}:${size}`)
    .digest('base64url')
    .slice(0, 27)}"`;
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': options.cacheControl ?? DEFAULT_CACHE_CONTROL,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const parsed = parseRange(request.headers.get('range'), size);

  if (parsed.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const range: ByteRange | null = parsed.kind === 'satisfiable' ? parsed.range : null;
  const headers = buildHeaders({ ...options, etag, range, size });

  // A HEAD request needs every header and no body. Answering it without
  // touching Telegram is both correct and free.
  if (request.method === 'HEAD') {
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  const body = await openBody(media, range, request.signal);
  return new Response(body, { status: range ? 206 : 200, headers });
}

function buildHeaders(input: {
  media: MediaFile;
  disposition: 'inline' | 'attachment';
  downloadName?: string;
  cacheControl?: string;
  etag: string;
  range: ByteRange | null;
  size: number;
}): Headers {
  const headers = new Headers();

  headers.set('Content-Type', input.media.mimeType);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', input.etag);
  headers.set('Cache-Control', input.cacheControl ?? DEFAULT_CACHE_CONTROL);
  headers.set('Content-Length', String(input.range ? rangeLength(input.range) : input.size));
  // The response is a media byte stream, never markup. Combined with the
  // global `X-Content-Type-Options: nosniff`, this stops a crafted upload from
  // ever being interpreted as HTML in the origin's own security context.
  headers.set('X-Content-Type-Options', 'nosniff');

  if (input.range) {
    headers.set('Content-Range', contentRangeHeader(input.range, input.size));
  }

  const name = input.downloadName ?? input.media.fileName;
  headers.set('Content-Disposition', contentDisposition(input.disposition, name));

  return headers;
}

/**
 * RFC 6266 / RFC 5987 Content-Disposition.
 *
 * The plain `filename` is reduced to ASCII for old clients; `filename*` carries
 * the real, possibly Tamil, name for everyone else. Quotes and backslashes are
 * stripped rather than escaped so no input can break out of the quoted string.
 */
export function contentDisposition(kind: 'inline' | 'attachment', fileName: string): string {
  const asciiName =
    fileName
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/["\\]/g, '')
      .trim() || 'download';

  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  return `${kind}; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}

/** Weak/strong ETag comparison over a possibly comma-separated header. */
function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(etag);
}

async function openBody(
  media: MediaFile,
  range: ByteRange | null,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const config = getConfig();
  const cacheable = media.fileSize > 0 && media.fileSize <= config.cache.maxFileBytes;

  if (cacheable) {
    const entry = await cache.withEntry(media.telegramFileUniqueId, async () => {
      // Always fetch the whole file when filling: a partial fill would poison
      // the cache for later full-file downloads.
      //
      // Deliberately not the caller's signal. A media element opens a range
      // request, takes what it needs and abandons the rest — that is normal
      // playback, not a reason to abort. Tying the fill to it meant the first
      // listener's disconnect killed the fill, and `withEntry` single-flights,
      // so it killed the fill for everyone waiting behind them too. The track
      // then never cached and every play re-fetched from Telegram. The fill
      // outlives the request that triggered it because it serves every later
      // request as well.
      const handle = await openMedia(media);
      return cache.store(media.telegramFileUniqueId, handle.body, media.fileSize);
    });

    if (entry) {
      const stream = createReadStream(
        entry.path,
        range ? { start: range.start, end: range.end } : undefined,
      );
      return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    }

    logger.warn('serve.cache_miss_fallthrough', { mediaId: media.id });
  }

  // Passthrough. Ask Telegram for the range; if it answers with the whole file
  // anyway, slice it here so the response still matches its Content-Range.
  const handle = await openMedia(media, {
    range: range ? { start: range.start, end: range.end } : undefined,
    signal,
  });

  if (!range || handle.rangeApplied) {
    return handle.body;
  }

  return sliceStream(handle.body, range.start, rangeLength(range));
}

/**
 * Drop `skip` bytes from the front of a stream and stop after `take` bytes.
 * Used only when an upstream ignores a Range request.
 */
export function sliceStream(
  source: ReadableStream<Uint8Array>,
  skip: number,
  take: number,
): ReadableStream<Uint8Array> {
  let skipped = 0;
  let emitted = 0;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let view = chunk;

      if (skipped < skip) {
        const toSkip = Math.min(skip - skipped, view.byteLength);
        skipped += toSkip;
        view = view.subarray(toSkip);
        if (view.byteLength === 0) return;
      }

      const remaining = take - emitted;
      if (remaining <= 0) {
        controller.terminate();
        return;
      }

      if (view.byteLength > remaining) {
        view = view.subarray(0, remaining);
      }

      emitted += view.byteLength;
      controller.enqueue(view);

      if (emitted >= take) controller.terminate();
    },
  });

  return source.pipeThrough(transform);
}
