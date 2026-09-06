/**
 * HTTP Range parsing (RFC 9110 §14).
 *
 * Audio seeking depends entirely on this: an `<audio>` element asks for
 * `bytes=<n>-` when the listener drags the scrubber, and Safari in particular
 * refuses to play at all unless the first response advertises
 * `Accept-Ranges: bytes` and answers a range request with 206.
 *
 * Pure and side-effect free so it can be exhaustively unit-tested.
 */

export interface ByteRange {
  /** First byte position, inclusive. */
  readonly start: number;
  /** Last byte position, inclusive. */
  readonly end: number;
}

export type RangeParseResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'satisfiable'; readonly range: ByteRange }
  | { readonly kind: 'unsatisfiable' };

/**
 * Parse a `Range` header against a known resource size.
 *
 * Handles the three documented forms — `bytes=a-b`, `bytes=a-`, `bytes=-n` —
 * and treats anything else (multiple ranges, a non-`bytes` unit, syntactic
 * junk) as absent, which the spec permits and which is friendlier than a 416.
 */
export function parseRange(header: string | null | undefined, size: number): RangeParseResult {
  if (!header) return { kind: 'none' };

  const match = /^bytes\s*=\s*(.+)$/i.exec(header.trim());
  if (!match) return { kind: 'none' };

  const spec = match[1] ?? '';
  // Multiple ranges are legal but rare, and answering them requires a
  // multipart/byteranges body. Serving the whole resource is a valid response.
  if (spec.includes(',')) return { kind: 'none' };

  const parts = /^(\d*)-(\d*)$/.exec(spec.trim());
  if (!parts) return { kind: 'none' };

  const rawStart = parts[1] ?? '';
  const rawEnd = parts[2] ?? '';

  if (rawStart === '' && rawEnd === '') return { kind: 'none' };

  // An empty resource can satisfy no range at all.
  if (size <= 0) return { kind: 'unsatisfiable' };

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength)) return { kind: 'none' };
    if (suffixLength === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - suffixLength);
    return { kind: 'satisfiable', range: { start, end: size - 1 } };
  }

  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start)) return { kind: 'none' };
  if (start >= size) return { kind: 'unsatisfiable' };

  if (rawEnd === '') {
    return { kind: 'satisfiable', range: { start, end: size - 1 } };
  }

  const requestedEnd = Number.parseInt(rawEnd, 10);
  if (!Number.isFinite(requestedEnd)) return { kind: 'none' };
  if (requestedEnd < start) return { kind: 'unsatisfiable' };

  return { kind: 'satisfiable', range: { start, end: Math.min(requestedEnd, size - 1) } };
}

export function contentRangeHeader(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}

export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}
