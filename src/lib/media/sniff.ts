/**
 * Content sniffing.
 *
 * A browser-supplied Content-Type and a filename extension are both attacker
 * controlled, so neither is trusted. Every upload is identified from its own
 * leading bytes, and the declared type only has to *agree* with what we find.
 *
 * Pure and dependency-free so it can be unit-tested exhaustively.
 */

export interface SniffResult {
  /** Canonical mime type detected from the byte signature. */
  readonly mime: string;
  /** Human-facing format name. */
  readonly format: string;
  readonly kind: 'audio' | 'image';
}

const ascii = (bytes: Uint8Array, start: number, length: number): string => {
  let out = '';
  for (let i = start; i < start + length && i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i] as number);
  }
  return out;
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * When the buffer begins with an ID3v2 tag, returns the offset just past it so
 * an MPEG frame header can be located behind the tag. Otherwise null.
 */
function id3Length(bytes: Uint8Array): number | null {
  if (!startsWith(bytes, [0x49, 0x44, 0x33])) return null; // "ID3"
  if (bytes.length < 10) return null;
  // Synchsafe 28-bit size, big endian, 7 significant bits per byte.
  const size =
    ((bytes[6] ?? 0) << 21) | ((bytes[7] ?? 0) << 14) | ((bytes[8] ?? 0) << 7) | (bytes[9] ?? 0);
  return 10 + size;
}

function isMpegFrameHeader(bytes: Uint8Array, offset: number): boolean {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  if (b0 === undefined || b1 === undefined) return false;
  // Frame sync: eleven set bits, then a non-reserved version and layer.
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return false;
  const version = (b1 & 0x18) >> 3;
  const layer = (b1 & 0x06) >> 1;
  return version !== 0b01 && layer !== 0b00;
}

/**
 * Identify a file from its first bytes. Pass at least 64 bytes; more is better
 * for MP3s that carry a large ID3 tag.
 */
export function sniff(bytes: Uint8Array): SniffResult | null {
  if (bytes.length < 4) return null;

  // --- Images -------------------------------------------------------------
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', format: 'JPEG', kind: 'image' };
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', format: 'PNG', kind: 'image' };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return { mime: 'image/webp', format: 'WebP', kind: 'image' };
  }

  // --- Audio --------------------------------------------------------------
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return { mime: 'audio/wav', format: 'WAV', kind: 'audio' };
  }
  if (ascii(bytes, 0, 4) === 'fLaC') {
    return { mime: 'audio/flac', format: 'FLAC', kind: 'audio' };
  }
  if (ascii(bytes, 0, 4) === 'OggS') {
    // Opus and Vorbis share the Ogg container; the codec identification header
    // sits just past the page header and its segment table.
    const window = ascii(bytes, 0, Math.min(bytes.length, 80));
    if (window.includes('OpusHead')) {
      return { mime: 'audio/opus', format: 'Opus', kind: 'audio' };
    }
    return { mime: 'audio/ogg', format: 'Ogg', kind: 'audio' };
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    // M4A/M4B/M4P are audio-only brands. Generic MP4/ISO brands may hold
    // video, which this site does not serve, so they are rejected.
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') {
      return { mime: 'audio/mp4', format: 'M4A', kind: 'audio' };
    }
    return null;
  }
  if (startsWith(bytes, [0xff, 0xf1]) || startsWith(bytes, [0xff, 0xf9])) {
    return { mime: 'audio/aac', format: 'AAC (ADTS)', kind: 'audio' };
  }

  // MP3: either a bare frame sync, or an ID3 tag followed by one.
  const tagLength = id3Length(bytes);
  if (tagLength !== null) {
    if (tagLength < bytes.length && isMpegFrameHeader(bytes, tagLength)) {
      return { mime: 'audio/mpeg', format: 'MP3', kind: 'audio' };
    }
    // The tag can be larger than the window we were handed. In practice an
    // ID3 tag is only ever attached to MPEG audio, so accept it.
    return { mime: 'audio/mpeg', format: 'MP3', kind: 'audio' };
  }
  if (isMpegFrameHeader(bytes, 0)) {
    return { mime: 'audio/mpeg', format: 'MP3', kind: 'audio' };
  }

  return null;
}

/**
 * Browsers and tag editors spell several of these types more than one way.
 * Collapse them so a declared type can be compared against a sniffed one.
 */
export function canonicaliseMime(mime: string): string {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  switch (base) {
    case 'audio/mp3':
    case 'audio/mpeg3':
    case 'audio/x-mpeg':
    case 'audio/x-mp3':
      return 'audio/mpeg';
    case 'audio/m4a':
    case 'audio/x-m4a':
    case 'audio/mp4a-latm':
      return 'audio/mp4';
    case 'audio/x-flac':
      return 'audio/flac';
    case 'audio/vorbis':
    case 'application/ogg':
    case 'audio/x-ogg':
      return 'audio/ogg';
    case 'audio/x-wav':
    case 'audio/wave':
    case 'audio/vnd.wave':
      return 'audio/wav';
    case 'audio/aacp':
    case 'audio/x-aac':
      return 'audio/aac';
    case 'image/jpg':
      return 'image/jpeg';
    default:
      return base;
  }
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = /[<>:"|?*]/g;

/**
 * Reduce a user-supplied filename to something safe to write to disk, put in a
 * Content-Disposition header, and hand to Telegram.
 *
 * Strips every path separator and control character, refuses `.` and `..`,
 * collapses whitespace, and caps the length. Never returns an empty string.
 */
export function sanitiseFileName(input: string, fallback = 'audio'): string {
  const withoutPath = input.split(/[\\/]/).pop() ?? '';
  const cleaned = withoutPath
    .replace(CONTROL_CHARACTERS, '')
    .replace(WINDOWS_RESERVED, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();

  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}

/**
 * Build the filename a visitor's browser will save, from the track's slug and
 * the stored mime type: `tamil-og-ringtone.mp3`.
 */
export function downloadFileName(slug: string, mime: string, extensionByMime: Record<string, string>): string {
  const extension = extensionByMime[canonicaliseMime(mime)] ?? 'bin';
  const base = sanitiseFileName(slug, 'audio').replace(/\.+$/, '');
  return `${base}.${extension}`;
}
