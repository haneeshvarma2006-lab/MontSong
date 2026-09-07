import { describe, expect, it } from 'vitest';

import {
  canonicaliseMime,
  downloadFileName,
  sanitiseFileName,
  sniff,
} from '@/lib/media/sniff';
import { EXTENSION_BY_MIME } from '@/lib/constants';
import {
  flacBytes,
  jpegBytes,
  m4aBytes,
  mp3Bytes,
  mp4VideoBytes,
  oggOpusBytes,
  pngBytes,
  shellScriptBytes,
  wavBytes,
} from '../helpers/fixtures';

describe('sniff', () => {
  it('identifies each accepted audio format from its signature', () => {
    expect(sniff(mp3Bytes())).toMatchObject({ mime: 'audio/mpeg', kind: 'audio' });
    expect(sniff(wavBytes())).toMatchObject({ mime: 'audio/wav', kind: 'audio' });
    expect(sniff(flacBytes())).toMatchObject({ mime: 'audio/flac', kind: 'audio' });
    expect(sniff(oggOpusBytes())).toMatchObject({ mime: 'audio/opus', kind: 'audio' });
    expect(sniff(m4aBytes())).toMatchObject({ mime: 'audio/mp4', kind: 'audio' });
  });

  it('identifies images', () => {
    expect(sniff(jpegBytes())).toMatchObject({ mime: 'image/jpeg', kind: 'image' });
    expect(sniff(pngBytes())).toMatchObject({ mime: 'image/png', kind: 'image' });
  });

  it('recognises a bare MPEG frame with no ID3 tag', () => {
    const bare = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64)]);
    expect(sniff(bare)).toMatchObject({ mime: 'audio/mpeg' });
  });

  it('recognises an MP3 whose ID3 tag is larger than the sniff window', () => {
    const id3 = Buffer.alloc(10);
    id3.write('ID3', 0, 'ascii');
    id3[3] = 3;
    // Synchsafe 100000-ish: far past any window we would read.
    id3[6] = 0x06;
    id3[7] = 0x0d;
    id3[8] = 0x20;
    id3[9] = 0x00;
    const truncated = Buffer.concat([id3, Buffer.alloc(200, 0x41)]);
    expect(sniff(truncated)).toMatchObject({ mime: 'audio/mpeg' });
  });

  it('rejects a script renamed to look like audio', () => {
    // This is the case the whole module exists for: the extension and the
    // declared type would both say "mp3", and the bytes say otherwise.
    expect(sniff(shellScriptBytes())).toBeNull();
  });

  it('rejects an MP4 with a video brand', () => {
    expect(sniff(mp4VideoBytes())).toBeNull();
  });

  it('returns null for input too short to identify', () => {
    expect(sniff(Buffer.from([0xff]))).toBeNull();
    expect(sniff(Buffer.alloc(0))).toBeNull();
  });

  it('does not mistake an OGG Vorbis file for Opus', () => {
    const vorbis = Buffer.concat([
      Buffer.from('OggS', 'ascii'),
      Buffer.alloc(24),
      Buffer.from('vorbis', 'ascii'),
      Buffer.alloc(64),
    ]);
    expect(sniff(vorbis)).toMatchObject({ mime: 'audio/ogg' });
  });
});

describe('canonicaliseMime', () => {
  it('collapses the many spellings browsers use', () => {
    expect(canonicaliseMime('audio/mp3')).toBe('audio/mpeg');
    expect(canonicaliseMime('AUDIO/X-M4A')).toBe('audio/mp4');
    expect(canonicaliseMime('audio/x-flac')).toBe('audio/flac');
    expect(canonicaliseMime('image/jpg')).toBe('image/jpeg');
    expect(canonicaliseMime('audio/mpeg; charset=binary')).toBe('audio/mpeg');
  });

  it('passes an unknown type through, lowercased', () => {
    expect(canonicaliseMime('Application/Weird')).toBe('application/weird');
  });
});

describe('sanitiseFileName', () => {
  it('strips directory traversal', () => {
    expect(sanitiseFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFileName('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitiseFileName('/absolute/path/song.mp3')).toBe('song.mp3');
  });

  it('refuses dot names', () => {
    expect(sanitiseFileName('.')).toBe('audio');
    expect(sanitiseFileName('..')).toBe('audio');
    expect(sanitiseFileName('...')).toBe('audio');
    expect(sanitiseFileName('')).toBe('audio');
  });

  it('removes control characters that could forge a header', () => {
    // CR/LF go because they could otherwise split a Content-Disposition header
    // in two; the colon goes with them, being reserved on Windows filesystems.
    expect(sanitiseFileName('song\r\nX-Injected: yes.mp3')).toBe('songX-Injected yes.mp3');
    expect(sanitiseFileName('song\u0000\u0007.mp3')).toBe('song.mp3');
  });

  it('keeps non-ASCII names intact', () => {
    expect(sanitiseFileName('தமிழ் பாடல்.mp3')).toBe('தமிழ் பாடல்.mp3');
  });

  it('caps the length', () => {
    expect(sanitiseFileName('a'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe('downloadFileName', () => {
  it('builds a clean name from the slug and stored type', () => {
    expect(downloadFileName('tamil-og-ringtone', 'audio/mpeg', EXTENSION_BY_MIME)).toBe(
      'tamil-og-ringtone.mp3',
    );
    expect(downloadFileName('bgm-theme', 'audio/flac', EXTENSION_BY_MIME)).toBe('bgm-theme.flac');
  });

  it('falls back to .bin for an unmapped type rather than producing no extension', () => {
    expect(downloadFileName('mystery', 'audio/weird', EXTENSION_BY_MIME)).toBe('mystery.bin');
  });
});
