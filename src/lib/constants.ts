/**
 * Shared vocabulary. Safe to import from client components — no secrets here.
 */

export const AUDIO_TYPES = ['song', 'ringtone', 'bgm', 'other'] as const;
export type AudioType = (typeof AUDIO_TYPES)[number];

export const AUDIO_TYPE_LABELS: Record<AudioType, string> = {
  song: 'Song',
  ringtone: 'Ringtone',
  bgm: 'BGM',
  other: 'Audio',
};

export function isAudioType(value: unknown): value is AudioType {
  return typeof value === 'string' && (AUDIO_TYPES as readonly string[]).includes(value);
}

/**
 * Audio formats we accept.
 *
 * The list is chosen for *browser playback*, not for what Telegram will hold:
 * MP3 and M4A/AAC play everywhere; OGG/Opus plays everywhere except older
 * Safari; WAV plays everywhere but is enormous; FLAC plays in every current
 * engine. Anything outside this list would upload fine and then fail to play
 * for some visitors, so it is rejected at the door.
 */
export const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/flac',
] as const;

export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Canonical extension for each accepted type, used when naming downloads. */
export const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const MEDIA_KINDS = ['audio', 'image'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const UPLOAD_INTENT_STATUSES = [
  'received',
  'uploading',
  'uploaded',
  'committed',
  'failed',
  'abandoned',
] as const;
export type UploadIntentStatus = (typeof UPLOAD_INTENT_STATUSES)[number];

export const SESSION_COOKIE_NAME = 'montsong_session';
export const CSRF_COOKIE_NAME = 'montsong_csrf';
export const CSRF_HEADER_NAME = 'x-montsong-csrf';

/** Sessions live a week; every authenticated request slides the window. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Only persist a slide when the session is older than this, to avoid a write per request. */
export const SESSION_SLIDE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Telegram guarantees a getFile path stays valid "for at least 1 hour". We
 * refresh at 45 minutes so an in-flight download never trips over the edge.
 */
export const TELEGRAM_FILE_PATH_TTL_MS = 45 * 60 * 1000;
