import path from 'node:path';

/**
 * Environment configuration.
 *
 * Everything here is server-only. Nothing in this module may be imported from
 * a client component — the Telegram token and auth secret live here, and a
 * stray import would bundle them into the browser payload. The `server-only`
 * guard below turns that mistake into a build error rather than a leak.
 */
import 'server-only';

class ConfigError extends Error {
  override name = 'ConfigError';
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

function bool(name: string, fallback = false): boolean {
  const value = optional(name);
  if (value === undefined) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

function int(name: string, fallback: number): number {
  const value = optional(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`Environment variable ${name} must be a positive integer, got "${value}".`);
  }
  return parsed;
}

/**
 * Telegram's documented ceilings, as of Bot API 10 (verified September 2026):
 *
 *   Cloud Bot API (api.telegram.org)
 *     - a bot may SEND files of up to 50 MB
 *     - getFile only works for files of up to 20 MB
 *   Local Bot API server (tdlib/telegram-bot-api, --local)
 *     - upload up to 2000 MB
 *     - download without a size limit
 *
 * Because this application has to serve every file back to a visitor, the
 * binding constraint on the cloud API is the 20 MB *download* limit, not the
 * 50 MB upload limit. Accepting a 40 MB upload would produce a track that can
 * never be played, so the ceiling below is the download limit.
 */
export const TELEGRAM_CLOUD_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_CLOUD_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_LOCAL_UPLOAD_LIMIT_BYTES = 2000 * 1024 * 1024;

export interface AppConfig {
  readonly databaseUrl: string;
  readonly telegram: {
    readonly botToken: string;
    readonly storageChatId: string;
    readonly apiBaseUrl: string;
    readonly localMode: boolean;
    readonly debug: boolean;
    /** Largest file this deployment can both store and serve back. */
    readonly effectiveFileLimitBytes: number;
  };
  readonly auth: {
    readonly username: string;
    readonly passwordHash: string;
    readonly secret: Buffer;
  };
  readonly site: {
    readonly url: string;
    readonly name: string;
  };
  readonly cache: {
    readonly dir: string;
    readonly maxBytes: number;
    readonly maxFileBytes: number;
  };
  readonly uploads: {
    readonly tmpDir: string;
    readonly maxAudioBytes: number;
    readonly maxImageBytes: number;
  };
  readonly trustedOrigins: readonly string[];
}

let cached: AppConfig | null = null;

/** Warnings raised while clamping configuration, surfaced on the admin health screen. */
const warnings: string[] = [];

export function getConfigWarnings(): readonly string[] {
  // Ensure the config has been read at least once so warnings are populated.
  try {
    getConfig();
  } catch {
    /* configuration errors are reported separately */
  }
  return warnings;
}

export function getConfig(): AppConfig {
  if (cached) return cached;

  const localMode = bool('TELEGRAM_API_LOCAL_MODE', false);
  const apiBaseUrl = (optional('TELEGRAM_API_BASE_URL') ?? 'https://api.telegram.org').replace(
    /\/+$/,
    '',
  );
  const usingCloudApi = apiBaseUrl === 'https://api.telegram.org';

  // On the cloud API the download limit binds; on a local server the upload
  // limit binds. Either way this is the largest file we will accept.
  const telegramCeiling = usingCloudApi
    ? TELEGRAM_CLOUD_DOWNLOAD_LIMIT_BYTES
    : TELEGRAM_LOCAL_UPLOAD_LIMIT_BYTES;

  const requestedAudioLimit = int('MAX_AUDIO_UPLOAD_BYTES', TELEGRAM_CLOUD_DOWNLOAD_LIMIT_BYTES);
  const maxAudioBytes = Math.min(requestedAudioLimit, telegramCeiling);
  if (requestedAudioLimit > telegramCeiling) {
    warnings.push(
      `MAX_AUDIO_UPLOAD_BYTES (${requestedAudioLimit}) exceeds what this Telegram mode can serve back ` +
        `(${telegramCeiling} bytes); clamped to ${maxAudioBytes}.`,
    );
  }

  const secretRaw = required('AUTH_SECRET');
  const secret = Buffer.from(secretRaw, 'base64');
  if (secret.length < 32) {
    throw new ConfigError(
      'AUTH_SECRET must decode to at least 32 bytes. Generate one with: ' +
        `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`,
    );
  }

  const passwordHash = required('ADMIN_PASSWORD_HASH');
  if (!passwordHash.startsWith('scrypt:')) {
    throw new ConfigError(
      'ADMIN_PASSWORD_HASH must be a scrypt hash produced by `npm run admin:password` ' +
        '(it looks like "scrypt:32768:8:1:<salt>:<hash>"). If you pasted one that used `$` ' +
        'separators, your .env loader expanded it as shell variables — regenerate it.',
    );
  }

  cached = {
    databaseUrl: optional('DATABASE_URL') ?? 'file:./data/montsong.db',
    telegram: {
      botToken: required('TELEGRAM_BOT_TOKEN'),
      storageChatId: required('TELEGRAM_STORAGE_CHAT_ID'),
      apiBaseUrl,
      localMode,
      debug: bool('TELEGRAM_DEBUG', false),
      effectiveFileLimitBytes: telegramCeiling,
    },
    auth: {
      username: required('ADMIN_USERNAME'),
      passwordHash,
      secret,
    },
    site: {
      url: (optional('NEXT_PUBLIC_SITE_URL') ?? 'http://localhost:3000').replace(/\/+$/, ''),
      name: optional('NEXT_PUBLIC_SITE_NAME') ?? 'MontSong',
    },
    cache: {
      // These resolve a *runtime* directory, not a module. The annotation stops
      // the bundler's static analysis from concluding it must trace the whole
      // project into the deployment output.
      dir: path.resolve(/* turbopackIgnore: true */ optional('MEDIA_CACHE_DIR') ?? './media-cache'),
      maxBytes: int('MEDIA_CACHE_MAX_BYTES', 2 * 1024 * 1024 * 1024),
      maxFileBytes: int('MEDIA_CACHE_MAX_FILE_BYTES', 64 * 1024 * 1024),
    },
    uploads: {
      tmpDir: path.resolve(/* turbopackIgnore: true */ optional('UPLOAD_TMP_DIR') ?? './tmp-uploads'),
      maxAudioBytes,
      maxImageBytes: int('MAX_IMAGE_UPLOAD_BYTES', 5 * 1024 * 1024),
    },
    trustedOrigins: (optional('ADDITIONAL_TRUSTED_ORIGINS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };

  return cached;
}

/** Test-only: forget the memoised config so a new environment can be applied. */
export function resetConfigForTests(): void {
  cached = null;
  warnings.length = 0;
}
