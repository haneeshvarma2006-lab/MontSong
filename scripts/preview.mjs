/**
 * Preview the site without a Telegram bot.
 *
 *   npm run preview
 *
 * Starts the bundled stand-in Bot API, sets up a throwaway database, fills it
 * with a demo library of real playable audio, and serves the application — so
 * every part of it works end to end: browsing, searching, playing, seeking,
 * downloading, and the whole admin.
 *
 * This exists because getting a bot from @BotFather is not always possible
 * immediately, and there is no reason to be blocked on it to see the site.
 *
 * Nothing here touches your real configuration: the workspace is `.preview/`,
 * which is gitignored, and `.env` is not read. Delete `.preview/` to reset.
 *
 * Flags:
 *   --port <n>      application port (default 3000)
 *   --bot-port <n>  stand-in Bot API port (default 8080)
 *   --fresh         wipe the workspace and rebuild the demo library
 *   --no-build      skip the production build (use the existing one)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const APP_PORT = Number(flag('port', 3000));
const BOT_PORT = Number(flag('bot-port', 8080));
const FRESH = argv.includes('--fresh');
const SKIP_BUILD = argv.includes('--no-build');

const BASE = `http://127.0.0.1:${APP_PORT}`;
const WORKSPACE = path.join(ROOT, '.preview');
const DEMO_USER = 'owner';

/**
 * A fresh password every run, printed once to this terminal.
 *
 * It was a constant. `next start` binds every interface, so a constant that
 * ships in the repository means anyone on the same network — a café, a campus,
 * a shared office — can sign in to a running preview as its owner and upload
 * files. Random per run, plus the loopback bind below, closes that.
 */
const DEMO_PASSWORD = `preview-${randomBytes(9).toString('base64url')}`;

const children = [];

// ---------------------------------------------------------------------------
// Demo audio
//
// Real, playable WAV files, synthesised here rather than shipped as binaries.
// A short chord with a gentle fade so the player has something to actually
// play, seek through and download — a placeholder file would leave the one
// part of the site people most want to try feeling broken.
// ---------------------------------------------------------------------------

function wav(seconds, frequencies) {
  const rate = 22050;
  const samples = Math.floor(rate * seconds);
  const data = Buffer.alloc(samples * 2);

  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    // Fade in and out so it does not click at the edges.
    const envelope = Math.min(1, t * 4, (seconds - t) * 4);
    let value = 0;
    for (const frequency of frequencies) {
      value += Math.sin(2 * Math.PI * frequency * t);
    }
    value = (value / frequencies.length) * envelope * 0.32;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/** A tiny solid-colour PNG, for cover art. */
function png(r, g, b) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const out = Buffer.alloc(8 + body.length + 4);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'ascii'), body])), 8 + body.length);
    return out;
  };

  const size = 240;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3;
      // A soft diagonal gradient so the covers are not flat blocks.
      const shade = 0.55 + (0.45 * (x + y)) / (2 * size);
      raw[at] = Math.round(r * shade);
      raw[at + 1] = Math.round(g * shade);
      raw[at + 2] = Math.round(b * shade);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CATEGORIES = [
  { name: 'Tamil OGs', slug: 'tamil-ogs', icon: '🎬', accent: '#ff8a3d', isFeatured: true,
    description: 'The originals — the ones everyone already knows the first note of.' },
  { name: 'Ringtones', slug: 'ringtones', icon: '📱', accent: '#5ddba0', isFeatured: true,
    description: 'Short, loud, and made to be heard across a room.' },
  { name: 'BGM', slug: 'bgm', icon: '🎻', accent: '#7aa2ff',
    description: 'Background scores and themes, without the vocals.' },
  { name: 'Mass Songs', slug: 'mass-songs', icon: '🔥', accent: '#ff6b6b',
    description: 'For the intro shots and the whistle-worthy drops.' },
  { name: 'Love Songs', slug: 'love-songs', icon: '💛', accent: '#ffd166',
    description: 'Slow, warm, and unhurried.' },
  { name: 'Sad Songs', slug: 'sad-songs', icon: '🌧️', accent: '#9aa0ff',
    description: 'For the drive home.' },
];

const TRACKS = [
  { title: 'Thalapathy Intro Theme', artist: 'Demo Artist', category: 'tamil-ogs', type: 'ringtone',
    tags: ['intro', 'mass'], seconds: 9, chord: [330, 415, 494], cover: [224, 82, 63], featured: true },
  { title: 'Vaathi Coming', artist: 'Demo Artist', category: 'mass-songs', type: 'song',
    tags: ['mass', 'dance'], seconds: 12, chord: [262, 330, 392], cover: [255, 138, 61], featured: true },
  { title: 'Kaadhal Kaditham', artist: 'Second Artist', category: 'love-songs', type: 'song',
    tags: ['melody', 'slow'], seconds: 14, chord: [294, 370, 440], cover: [255, 209, 102] },
  { title: 'Rain Theme', artist: 'Third Artist', category: 'bgm', type: 'bgm',
    tags: ['strings', 'calm'], seconds: 11, chord: [220, 277, 330] },
  { title: 'Ennai Vittu', artist: 'Second Artist', category: 'sad-songs', type: 'song',
    tags: ['sad', 'slow'], seconds: 13, chord: [247, 294, 370], cover: [154, 160, 255] },
  { title: 'Notification Blip', artist: null, category: 'ringtones', type: 'ringtone',
    tags: ['short', 'clean'], seconds: 3, chord: [660, 880] },
  { title: 'Beast Mode', artist: 'Demo Artist', category: 'mass-songs', type: 'song',
    tags: ['mass', 'loud'], seconds: 10, chord: [294, 349, 440], cover: [255, 107, 107] },
  { title: 'Morning Flute', artist: 'Third Artist', category: 'bgm', type: 'bgm',
    tags: ['flute', 'soft'], seconds: 12, chord: [392, 494, 587] },
];

// ---------------------------------------------------------------------------

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

function background(command, args, env, label) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, ...env },
  });
  children.push(child);
  const forward = (stream) => {
    stream.on('data', (chunk) => {
      if (process.env.PREVIEW_VERBOSE) process.stdout.write(`[${label}] ${chunk}`);
    });
  };
  forward(child.stdout);
  forward(child.stderr);
  return child;
}

function shutdown() {
  for (const child of children) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.log('\nStopping the preview…');
    shutdown();
    process.exit(0);
  });
}

async function waitFor(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function assertPortFree(port, label) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200) });
  } catch {
    return;
  }
  throw new Error(
    `Port ${port} is already in use (${label}). Stop what is listening, or pass a different ` +
      `--${label === 'the application' ? 'port' : 'bot-port'}.`,
  );
}

// --- An HTTP client that speaks the admin API -------------------------------

const jar = new Map();

function storeCookies(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const equals = pair.indexOf('=');
    jar.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
  }
}

async function api(pathname, init = {}) {
  const headers = new Headers(init.headers);
  if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  if (init.method && !['GET', 'HEAD'].includes(init.method)) {
    headers.set('origin', BASE);
    const csrf = jar.get('montsong_csrf');
    if (csrf) headers.set('x-montsong-csrf', decodeURIComponent(csrf));
  }
  const response = await fetch(`${BASE}${pathname}`, { ...init, headers, redirect: 'manual' });
  storeCookies(response);
  return response;
}

async function seedDemoLibrary() {
  const login = await api('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: DEMO_USER, password: DEMO_PASSWORD }),
  });
  if (login.status !== 200) throw new Error(`demo sign-in failed: ${await login.text()}`);

  const bySlug = new Map();
  for (const category of CATEGORIES) {
    const response = await api('/api/admin/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(category),
    });
    if (response.status === 201) {
      const body = await response.json();
      bySlug.set(category.slug, body.category.id);
    }
  }
  console.log(`  ${bySlug.size} categories`);

  let added = 0;
  for (const track of TRACKS) {
    const audio = wav(track.seconds, track.chord);
    const form = new FormData();
    form.append('audio', new Blob([audio], { type: 'audio/wav' }), `${track.title}.wav`);
    if (track.cover) {
      form.append('cover', new Blob([png(...track.cover)], { type: 'image/png' }), 'cover.png');
    }
    form.append(
      'metadata',
      JSON.stringify({
        title: track.title,
        artist: track.artist ?? undefined,
        categoryId: bySlug.get(track.category),
        type: track.type,
        tags: track.tags,
        isPublished: true,
        isFeatured: track.featured ?? false,
        durationSec: track.seconds,
        description: `A demo track, synthesised locally so the player has something real to play.`,
      }),
    );

    const response = await api('/api/admin/audio', { method: 'POST', body: form });
    if (response.status === 201) added += 1;
    else console.warn(`  could not add "${track.title}": ${(await response.text()).slice(0, 160)}`);
  }
  console.log(`  ${added} tracks`);

  // A little download history, so the dashboard has numbers to show.
  const listed = await api('/api/admin/audio?perPage=50');
  if (listed.status === 200) {
    const { items } = await listed.json();
    for (const [index, item] of items.entries()) {
      for (let n = 0; n < (index * 3) % 9; n += 1) {
        await (await fetch(`${BASE}${item.downloadUrl}`)).arrayBuffer();
      }
    }
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  await assertPortFree(APP_PORT, 'the application');
  await assertPortFree(BOT_PORT, 'the stand-in Bot API');

  if (FRESH) rmSync(WORKSPACE, { recursive: true, force: true });

  const isNew = !existsSync(path.join(WORKSPACE, 'preview.db'));
  mkdirSync(WORKSPACE, { recursive: true });

  const salt = randomBytes(16);
  const derived = scryptSync(DEMO_PASSWORD, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 256 * 16384 * 8 });

  const env = {
    NODE_ENV: 'production',
    PORT: String(APP_PORT),
    DATABASE_URL: `file:${path.join(WORKSPACE, 'preview.db')}`,
    // A stand-in for Telegram, running on this machine. No bot, no account, no
    // network — every file lives in that process's memory for the session.
    TELEGRAM_API_BASE_URL: `http://127.0.0.1:${BOT_PORT}`,
    TELEGRAM_BOT_TOKEN: '000000000:PREVIEW-ONLY-NOT-A-REAL-TOKEN',
    TELEGRAM_STORAGE_CHAT_ID: '-1000000000001',
    ADMIN_USERNAME: DEMO_USER,
    ADMIN_PASSWORD_HASH: ['scrypt', 16384, 8, 1, salt.toString('base64'), derived.toString('base64')].join(':'),
    AUTH_SECRET: randomBytes(48).toString('base64'),
    NEXT_PUBLIC_SITE_URL: `http://localhost:${APP_PORT}`,
    NEXT_PUBLIC_SITE_NAME: 'MontSong',
    MEDIA_CACHE_DIR: path.join(WORKSPACE, 'cache'),
    UPLOAD_TMP_DIR: path.join(WORKSPACE, 'uploads'),
    MAX_AUDIO_UPLOAD_BYTES: String(20 * 1024 * 1024),
    LOG_LEVEL: 'warn',
    NO_PROXY: '127.0.0.1,localhost',
  };

  console.log('Preparing the preview…');
  run('npx', ['prisma', 'migrate', 'deploy'], env);

  if (!SKIP_BUILD) {
    console.log('Building (about 20 seconds)…');
    run('npm', ['run', 'build'], env);
  }

  background('node', [path.join('tests', 'e2e', 'fake-bot-api.mjs'), String(BOT_PORT)], env, 'storage');
  await waitFor(`http://127.0.0.1:${BOT_PORT}/botX/getMe`);

  // Loopback only. This is a throwaway instance carrying a generated admin
  // credential; it has no business being reachable from the rest of the
  // network. `next start` would otherwise bind 0.0.0.0.
  background('npm', ['run', 'start', '--', '--hostname', '127.0.0.1'], env, 'app');
  await waitFor(BASE);

  if (isNew) {
    console.log('Adding a demo library…');
    await seedDemoLibrary();
  } else {
    // The stand-in storage only lives as long as its process, so the files
    // referenced by an existing database are gone. Say so rather than letting
    // playback fail mysteriously.
    console.log('Reusing the existing preview database.');
    console.log('If tracks will not play, run `npm run preview -- --fresh` to rebuild the library.');
  }

  console.log(`
──────────────────────────────────────────────────────────────
  MontSong preview is running

  Site      ${BASE}
  Admin     ${BASE}/admin
  Username  ${DEMO_USER}
  Password  ${DEMO_PASSWORD}

  Everything works: browse, search, play, seek, download, and
  the full admin including uploading your own audio files.

  Storage is a stand-in running on this machine — no Telegram
  bot, no account, nothing leaves your computer. Uploads live
  in that process's memory and are gone when you stop it.

  Press Ctrl-C to stop.
──────────────────────────────────────────────────────────────
`);

  // Hold the process open until interrupted.
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(`\nThe preview could not start:\n${error.message}\n`);
  shutdown();
  process.exit(1);
});
