import { describe, expect, it } from 'vitest';

import { contentRangeHeader, parseRange, rangeLength } from '@/lib/media/range';
import { contentDisposition, sliceStream } from '@/lib/media/serve';

const SIZE = 1000;

describe('parseRange', () => {
  it('treats an absent or unparseable header as no range', () => {
    expect(parseRange(null, SIZE)).toEqual({ kind: 'none' });
    expect(parseRange('', SIZE)).toEqual({ kind: 'none' });
    expect(parseRange('items=0-10', SIZE)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=', SIZE)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=-', SIZE)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=abc-def', SIZE)).toEqual({ kind: 'none' });
  });

  it('parses a closed range', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 0, end: 499 },
    });
  });

  it('parses an open-ended range, which is what a seeking audio element sends', () => {
    expect(parseRange('bytes=500-', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 500, end: 999 },
    });
  });

  it('parses a suffix range', () => {
    expect(parseRange('bytes=-200', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 800, end: 999 },
    });
  });

  it('clamps a suffix longer than the resource to the whole resource', () => {
    expect(parseRange('bytes=-5000', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 0, end: 999 },
    });
  });

  it('clamps an end past the resource', () => {
    expect(parseRange('bytes=900-99999', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 900, end: 999 },
    });
  });

  it('reports a start past the end of the resource as unsatisfiable', () => {
    expect(parseRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=5000-6000', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports a reversed range as unsatisfiable', () => {
    expect(parseRange('bytes=500-100', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports a zero-length suffix as unsatisfiable', () => {
    expect(parseRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('cannot satisfy any range against an empty resource', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('serves the whole resource for a multi-range request rather than failing', () => {
    // Answering multiple ranges needs a multipart/byteranges body; returning
    // everything is a legal and much simpler response.
    expect(parseRange('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'none' });
  });

  it('tolerates whitespace', () => {
    expect(parseRange('  bytes = 10-20  ', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 10, end: 20 },
    });
  });

  it('handles the single-byte range some players probe with', () => {
    expect(parseRange('bytes=0-0', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 0, end: 0 },
    });
    expect(rangeLength({ start: 0, end: 0 })).toBe(1);
  });
});

describe('contentRangeHeader', () => {
  it('formats as the spec requires', () => {
    expect(contentRangeHeader({ start: 0, end: 499 }, 1000)).toBe('bytes 0-499/1000');
  });
});

describe('contentDisposition', () => {
  it('offers both an ASCII name and a UTF-8 one', () => {
    const header = contentDisposition('attachment', 'தமிழ்-song.mp3');
    expect(header).toContain('attachment;');
    expect(header).toContain("filename*=UTF-8''");
    // Everything before filename* must be ASCII-safe for older clients.
    const asciiPart = header.slice(0, header.indexOf('filename*'));
    expect(/^[\x20-\x7e]*$/.test(asciiPart)).toBe(true);
  });

  it('cannot be escaped out of the quoted string', () => {
    const header = contentDisposition('attachment', 'evil".mp3; download-all="yes');
    const quoted = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
    expect(quoted).not.toContain('"');
    expect(quoted).not.toContain('\\');
  });

  it('never produces an empty filename', () => {
    expect(contentDisposition('attachment', '')).toContain('filename="download"');
    expect(contentDisposition('attachment', 'தமிழ்')).toContain('filename="download"');
  });
});

describe('sliceStream', () => {
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  };

  const sourceOf = (bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          controller.enqueue(bytes.subarray(offset, offset + chunkSize));
        }
        controller.close();
      },
    });

  it('extracts a range that straddles chunk boundaries', async () => {
    const source = Buffer.from(Array.from({ length: 100 }, (_, index) => index % 256));
    const result = await collect(sliceStream(sourceOf(source, 7), 10, 20));
    expect(Buffer.from(result)).toEqual(source.subarray(10, 30));
  });

  it('handles a range that starts at zero', async () => {
    const source = Buffer.alloc(50, 9);
    const result = await collect(sliceStream(sourceOf(source, 8), 0, 10));
    expect(result.byteLength).toBe(10);
  });

  it('stops early rather than reading the whole source', async () => {
    const source = Buffer.alloc(1000, 3);
    const result = await collect(sliceStream(sourceOf(source, 100), 950, 50));
    expect(result.byteLength).toBe(50);
  });

  it('handles a skip that consumes several whole chunks', async () => {
    const source = Buffer.from(Array.from({ length: 60 }, (_, index) => index));
    const result = await collect(sliceStream(sourceOf(source, 10), 35, 5));
    expect(Buffer.from(result)).toEqual(source.subarray(35, 40));
  });
});
