import 'server-only';

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import busboy from 'busboy';

import { getConfig } from '../env';
import { badRequest, payloadTooLarge, unsupportedMediaType } from '../errors';
import { createToken } from '../ids';
import { logger } from '../logger';
import { formatBytes } from '../format';
import { canonicaliseMime, sanitiseFileName, sniff } from '../media/sniff';

/**
 * Streaming multipart upload spooling.
 *
 * The obvious implementation — `await request.formData()` — buffers every part
 * into memory as a Blob before the handler sees any of it. That is fine for a
 * 2 MB ringtone and catastrophic for a 2 GB file on a local Bot API server, and
 * it means a request is charged to RAM before its size can even be checked.
 *
 * So the request body is parsed as it arrives: busboy splits the stream, each
 * file part is written straight to a temporary file on disk, the byte count is
 * enforced *during* the write (so an oversized upload is aborted mid-flight
 * rather than after it lands), and the leading bytes are captured for content
 * sniffing. Peak memory is one 64 KiB chunk regardless of upload size.
 *
 * Every caller must call `cleanup()` — in a `finally` — whether or not the
 * upload succeeded.
 */

/** Bytes retained from the head of each file for signature detection. */
const SNIFF_WINDOW = 512;

export interface SpooledFile {
  readonly field: string;
  /** Absolute path to the temporary file. */
  readonly path: string;
  /** Original filename, already sanitised. */
  readonly fileName: string;
  /** Content type declared by the client. Untrusted. */
  readonly declaredMimeType: string;
  /** Content type detected from the bytes. Authoritative. */
  readonly detectedMimeType: string | null;
  readonly detectedFormat: string | null;
  readonly kind: 'audio' | 'image' | null;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SpoolResult {
  readonly files: SpooledFile[];
  readonly fields: Record<string, string>;
  /** Deletes every temporary file. Safe to call more than once. */
  readonly cleanup: () => Promise<void>;
}

export interface SpoolLimits {
  /** Byte ceiling per file part. */
  readonly maxFileBytes: number;
  /** How many file parts are allowed. */
  readonly maxFiles?: number;
  /** Byte ceiling for a single non-file field value. */
  readonly maxFieldBytes?: number;
}

class UploadTooLarge extends Error {
  constructor(readonly limitBytes: number) {
    super(`upload exceeded ${limitBytes} bytes`);
  }
}

/**
 * Parse a multipart/form-data request, spooling file parts to disk.
 *
 * Rejects a non-multipart request, a missing boundary, more parts than
 * `maxFiles`, and any part that exceeds `maxFileBytes`.
 */
export async function spoolMultipart(
  request: Request,
  limits: SpoolLimits,
): Promise<SpoolResult> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw unsupportedMediaType('Expected a multipart/form-data upload.');
  }
  if (!request.body) {
    throw badRequest('The upload had no body.');
  }

  // A declared Content-Length over the limit is rejected before a single byte
  // is read. The per-chunk check below still runs, because Content-Length is
  // client-supplied and a chunked request has none at all.
  const declaredLength = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > limits.maxFileBytes * 1.05 + 1_000_000) {
    throw payloadTooLarge(
      `That upload is larger than the ${formatBytes(limits.maxFileBytes)} limit.`,
    );
  }

  const tmpDir = getConfig().uploads.tmpDir;
  await mkdir(tmpDir, { recursive: true });

  const spooled: SpooledFile[] = [];
  const fields: Record<string, string> = {};
  const writtenPaths: string[] = [];

  const cleanup = async () => {
    await Promise.all(
      writtenPaths.map((filePath) =>
        rm(filePath, { force: true }).catch((error: unknown) =>
          logger.warn('upload.cleanup_failed', { filePath, reason: String(error) }),
        ),
      ),
    );
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const parser = busboy({
        headers: { 'content-type': contentType },
        limits: {
          files: limits.maxFiles ?? 2,
          fileSize: limits.maxFileBytes,
          fieldSize: limits.maxFieldBytes ?? 64 * 1024,
          fields: 40,
          // Guard against a hostile part name being used as a path or key.
          fieldNameSize: 100,
        },
      });

      let pending = 0;
      let finished = false;
      let settled = false;

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const maybeResolve = () => {
        if (settled) return;
        if (finished && pending === 0) {
          settled = true;
          resolve();
        }
      };

      parser.on('field', (name, value) => {
        fields[name] = value;
      });

      parser.on('file', (field, stream, info) => {
        pending += 1;

        const fileName = sanitiseFileName(info.filename ?? '', 'upload');
        const tempPath = path.join(tmpDir, `${createToken(12)}.part`);
        writtenPaths.push(tempPath);

        const hash = createHash('sha256');
        const head: Buffer[] = [];
        let headBytes = 0;
        let bytes = 0;
        let truncated = false;

        const sink = createWriteStream(tempPath);

        stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          hash.update(chunk);
          if (headBytes < SNIFF_WINDOW) {
            const slice = chunk.subarray(0, SNIFF_WINDOW - headBytes);
            head.push(slice);
            headBytes += slice.length;
          }
        });

        // busboy raises this the moment fileSize is exceeded, so an oversized
        // upload stops costing bandwidth immediately.
        stream.on('limit', () => {
          truncated = true;
          fail(new UploadTooLarge(limits.maxFileBytes));
        });

        stream.on('error', fail);
        sink.on('error', fail);

        sink.on('close', () => {
          pending -= 1;
          if (truncated || settled) {
            maybeResolve();
            return;
          }

          const detected = sniff(new Uint8Array(Buffer.concat(head)));
          spooled.push({
            field,
            path: tempPath,
            fileName,
            declaredMimeType: canonicaliseMime(info.mimeType ?? ''),
            detectedMimeType: detected?.mime ?? null,
            detectedFormat: detected?.format ?? null,
            kind: detected?.kind ?? null,
            bytes,
            sha256: hash.digest('hex'),
          });
          maybeResolve();
        });

        stream.pipe(sink);
      });

      parser.on('filesLimit', () => fail(badRequest('Too many files in that upload.')));
      parser.on('fieldsLimit', () => fail(badRequest('Too many form fields in that upload.')));
      parser.on('error', fail);

      parser.on('close', () => {
        finished = true;
        maybeResolve();
      });

      // Web ReadableStream -> Node Readable, so nothing is buffered in between.
      const nodeStream = Readable.fromWeb(
        request.body as Parameters<typeof Readable.fromWeb>[0],
      );
      nodeStream.on('error', fail);
      nodeStream.pipe(parser);
    });
  } catch (error) {
    await cleanup();
    if (error instanceof UploadTooLarge) {
      throw payloadTooLarge(
        `That file is larger than the ${formatBytes(error.limitBytes)} limit for this site.`,
      );
    }
    throw error;
  }

  return { files: spooled, fields, cleanup };
}

/** Find one spooled part by field name. */
export function fileByField(result: SpoolResult, field: string): SpooledFile | undefined {
  return result.files.find((file) => file.field === field);
}

/** Confirm the spooled file is still on disk and the size we recorded. */
export async function assertSpoolIntact(file: SpooledFile): Promise<void> {
  const info = await stat(file.path).catch(() => null);
  if (!info?.isFile() || info.size !== file.bytes) {
    throw badRequest('The upload was interrupted. Please try again.');
  }
}

