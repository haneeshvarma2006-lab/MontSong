/**
 * Byte-level fixtures.
 *
 * These are real file signatures, not placeholders — the point of the upload
 * tests is that validation reads the actual bytes, so feeding it fake bytes
 * would test nothing.
 */

/** A minimal but structurally valid MP3: ID3v2 tag followed by an MPEG frame. */
export function mp3Bytes(payloadBytes = 4096): Buffer {
  const id3 = Buffer.alloc(10);
  id3.write('ID3', 0, 'ascii');
  id3[3] = 0x03; // version 2.3
  id3[4] = 0x00;
  id3[5] = 0x00;
  // Synchsafe size of zero: the tag is just the header.
  id3[6] = 0;
  id3[7] = 0;
  id3[8] = 0;
  id3[9] = 0;

  // MPEG-1 Layer III, 128 kbps, 44.1 kHz.
  const frameHeader = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const payload = Buffer.alloc(Math.max(0, payloadBytes - frameHeader.length), 0x55);

  return Buffer.concat([id3, frameHeader, payload]);
}

/** A WAV file with a correct RIFF/WAVE header. */
export function wavBytes(payloadBytes = 2048): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + payloadBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(88200, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(payloadBytes, 40);

  return Buffer.concat([header, Buffer.alloc(payloadBytes, 0x01)]);
}

export function flacBytes(payloadBytes = 1024): Buffer {
  return Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(payloadBytes, 0x02)]);
}

export function oggOpusBytes(payloadBytes = 1024): Buffer {
  const page = Buffer.alloc(28);
  page.write('OggS', 0, 'ascii');
  const head = Buffer.from('OpusHead', 'ascii');
  return Buffer.concat([page, head, Buffer.alloc(payloadBytes, 0x03)]);
}

export function m4aBytes(payloadBytes = 1024): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16, 0);
  header.write('ftyp', 4, 'ascii');
  header.write('M4A ', 8, 'ascii');
  header.writeUInt32BE(0, 12);
  return Buffer.concat([header, Buffer.alloc(payloadBytes, 0x04)]);
}

export function jpegBytes(payloadBytes = 512): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(payloadBytes, 0x06),
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function pngBytes(payloadBytes = 512): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(payloadBytes, 0x07),
  ]);
}

/** A shell script pretending to be an MP3 — the spoofing case. */
export function shellScriptBytes(): Buffer {
  return Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8');
}

/** An MP4 with a video brand, which must be rejected even though it is media. */
export function mp4VideoBytes(): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16, 0);
  header.write('ftyp', 4, 'ascii');
  header.write('isom', 8, 'ascii');
  return Buffer.concat([header, Buffer.alloc(256, 0x08)]);
}

/**
 * Build a multipart/form-data request body without touching the DOM.
 * Returns the body and the matching content-type header.
 */
export function multipart(parts: {
  fields?: Record<string, string>;
  files?: { field: string; fileName: string; contentType: string; bytes: Buffer }[];
}): { body: Buffer; contentType: string } {
  const boundary = `----montsongtest${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(parts.fields ?? {})) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  for (const file of parts.files ?? []) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; ` +
          `filename="${file.fileName}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        'utf8',
      ),
      file.bytes,
      Buffer.from('\r\n', 'utf8'),
    );
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
