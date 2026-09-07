/**
 * End-to-end test.
 *
 * Builds the application, starts it as a real production server against a
 * stand-in Bot API, and drives it over HTTP exactly as a browser would.
 *
 * This exists because a whole class of defect is invisible to the route-handler
 * tests. Those call handlers as functions; they cannot see response status
 * codes that the framework decides. Two real bugs found this way:
 *
 *   - A root `loading.tsx` opened a Suspense boundary that streamed `200 OK`
 *     before `notFound()` or `redirect()` could run, turning every 404 into a
 *     soft 404 and the admin guard's redirect into a client-side one.
 *   - The admin origin check derived its expected origin from the configured
 *     site URL, so every write failed behind a TLS-terminating proxy and on
 *     any other hostname.
 *
 * Both now have assertions below.
 *
 * Usage:  npm run test:e2e
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scryptSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const APP_PORT = Number(process.env.E2E_PORT ?? 3711);
const BOT_PORT = Number(process.env.E2E_BOT_PORT ?? 8711);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const PASSWORD = 'e2e-test-password-4821';

let failures = 0;
const started = [];
const workspace = mkdtempSync(path.join(tmpdir(), 'montsong-e2e-'));

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function section(name) {
  console.log(`\n${name}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: 'pipe',
      ...options,
      env: { ...process.env, ...options.env },
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}\n${output}`)),
    );
  });
}

function background(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: 'pipe',
    // Its own process group, so cleanup can signal the whole tree. `npm run
    // start` spawns the real server as a grandchild; killing only the npm
    // wrapper leaves that server holding the port, which then breaks the next
    // run in a way that looks like a test failure.
    detached: true,
    ...options,
    env: { ...process.env, ...options.env },
  });
  started.push(child);
  child.stdout?.on('data', (chunk) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    if (process.env.E2E_VERBOSE) process.stderr.write(chunk);
  });
  return child;
}

/**
 * Refuse to run against something already listening.
 *
 * Without this, a server left over from an earlier run answers on the port,
 * `waitFor` is satisfied by it, and the suite silently tests the wrong process
 * against the wrong database — which surfaces as a baffling "already uploaded"
 * failure rather than "the port is busy".
 */
async function assertPortFree(port, label) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return; // nothing there, which is what we want
  }
  throw new Error(
    `Port ${port} is already in use (${label}). Stop whatever is listening and re-run — ` +
      'otherwise this suite would test that process instead of a fresh one.',
  );
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function cleanup() {
  for (const child of started) {
    if (child.pid === undefined) continue;
    try {
      // Negative pid signals the whole process group.
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  rmSync(workspace, { recursive: true, force: true });
}

// A crash or Ctrl-C must not leave a server holding the port either.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanup();
    process.exit(1);
  });
}

// --- Fixtures ---------------------------------------------------------------

function mp3(size) {
  const id3 = Buffer.alloc(10);
  id3.write('ID3', 0, 'ascii');
  id3[3] = 3;
  const frame = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const body = Buffer.alloc(size);
  for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
  return Buffer.concat([id3, frame, body]);
}

const jpeg = () =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 9), Buffer.from([0xff, 0xd9])]);

// --- HTTP client with a cookie jar -----------------------------------------

const jar = new Map();

function storeCookies(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const equals = pair.indexOf('=');
    jar.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
  }
}

const cookieHeader = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');

async function req(pathname, init = {}) {
  const headers = new Headers(init.headers);
  if (jar.size) headers.set('cookie', cookieHeader());
  if (init.method && !['GET', 'HEAD'].includes(init.method)) {
    if (!headers.has('origin')) headers.set('origin', BASE);
    const csrf = jar.get('montsong_csrf');
    if (csrf && !headers.has('x-montsong-csrf')) {
      headers.set('x-montsong-csrf', decodeURIComponent(csrf));
    }
  }
  const response = await fetch(`${BASE}${pathname}`, { ...init, headers, redirect: 'manual' });
  storeCookies(response);
  return response;
}

// --- Main -------------------------------------------------------------------

async function main() {
  const databaseFile = path.join(workspace, 'e2e.db');
  const salt = randomBytes(16);
  const derived = scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 256 * 16384 * 8 });
  const passwordHash = ['scrypt', 16384, 8, 1, salt.toString('base64'), derived.toString('base64')].join(
    ':',
  );

  const env = {
    NODE_ENV: 'production',
    PORT: String(APP_PORT),
    DATABASE_URL: `file:${databaseFile}`,
    TELEGRAM_BOT_TOKEN: '999888777:E2E-BOT-TOKEN-SHOULD-NEVER-APPEAR',
    TELEGRAM_STORAGE_CHAT_ID: '-1001111111111',
    TELEGRAM_API_BASE_URL: `http://127.0.0.1:${BOT_PORT}`,
    ADMIN_USERNAME: 'e2e-owner',
    ADMIN_PASSWORD_HASH: passwordHash,
    AUTH_SECRET: randomBytes(48).toString('base64'),
    NEXT_PUBLIC_SITE_URL: `http://localhost:${APP_PORT}`,
    NEXT_PUBLIC_SITE_NAME: 'MontSong',
    MEDIA_CACHE_DIR: path.join(workspace, 'cache'),
    UPLOAD_TMP_DIR: path.join(workspace, 'uploads'),
    MAX_AUDIO_UPLOAD_BYTES: String(20 * 1024 * 1024),
    LOG_LEVEL: 'error',
    NO_PROXY: '127.0.0.1,localhost',
  };

  await assertPortFree(APP_PORT, 'the application port');
  await assertPortFree(BOT_PORT, 'the stand-in Bot API port');

  console.log('Preparing database…');
  await run('npx', ['prisma', 'migrate', 'deploy'], { env });

  console.log('Building…');
  await run('npm', ['run', 'build'], { env });

  console.log('Starting stand-in Bot API…');
  background('node', [path.join('tests', 'e2e', 'fake-bot-api.mjs'), String(BOT_PORT)], { env });
  await waitFor(`http://127.0.0.1:${BOT_PORT}/botX/getMe`);

  console.log('Starting the application…');
  background('npm', ['run', 'start'], { env });
  await waitFor(BASE);

  // ==========================================================================

  section('Public site, before any content exists');

  let res = await fetch(`${BASE}/`);
  let html = await res.text();
  check('homepage renders', res.status === 200 && html.includes('MontSong'));
  check(
    'security headers are set',
    res.headers.get('x-content-type-options') === 'nosniff' &&
      (res.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'") &&
      res.headers.get('referrer-policy') === 'strict-origin-when-cross-origin',
  );
  check('no x-powered-by header', res.headers.get('x-powered-by') === null);

  res = await fetch(`${BASE}/robots.txt`);
  const robots = await res.text();
  check('robots.txt keeps crawlers out of admin and api', robots.includes('/admin') && robots.includes('/api/'));

  section('A missing page answers 404, not a soft 404');

  // Regression: a root loading.tsx once made these stream a 200.
  res = await fetch(`${BASE}/song/no-such-song`);
  check('unknown song is a real 404', res.status === 404, `got ${res.status}`);
  res = await fetch(`${BASE}/category/no-such-category`);
  check('unknown category is a real 404', res.status === 404, `got ${res.status}`);

  section('The admin area is closed');

  res = await fetch(`${BASE}/admin`, { redirect: 'manual' });
  check('admin page redirects an anonymous visitor', res.status === 307, `got ${res.status}`);
  const redirectedBody = await res.text();
  check('no admin markup is sent to an anonymous visitor', !redirectedBody.includes('stat__value'));

  for (const endpoint of ['/api/admin/categories', '/api/admin/audio', '/api/admin/analytics', '/api/admin/storage']) {
    res = await fetch(`${BASE}${endpoint}`);
    check(`${endpoint} answers 401`, res.status === 401, `got ${res.status}`);
  }

  res = await fetch(`${BASE}/api/admin/audio`, { method: 'POST' });
  check('anonymous upload answers 401', res.status === 401, `got ${res.status}`);

  section('Signing in');

  res = await req('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'e2e-owner', password: 'wrong' }),
  });
  check('a wrong password is refused', res.status === 401);

  res = await req('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'e2e-owner', password: PASSWORD }),
  });
  check('the owner can sign in', res.status === 200, await res.clone().text());
  check('a session cookie is issued', jar.has('montsong_session'));

  // Regression: the origin check must accept the host actually being used,
  // which here is 127.0.0.1 while the configured site URL says localhost.
  check('signing in works on a host other than the configured one', res.status === 200);

  section('Storage connection');

  res = await req('/api/admin/storage/test', { method: 'POST' });
  let body = await res.json();
  check('the storage connection test passes', res.status === 200 && body.report.ok, JSON.stringify(body));

  section('Categories');

  const categories = [];
  for (const name of ['Tamil OGs', 'Ringtones', 'BGM']) {
    res = await req('/api/admin/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, icon: '🎵' }),
    });
    body = await res.json();
    if (res.status === 201) categories.push(body.category);
    else check(`create "${name}"`, false, JSON.stringify(body));
  }
  check('three categories created', categories.length === 3, categories.map((c) => c.slug).join(', '));

  res = await req('/api/admin/categories/reorder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [categories[2].id, categories[0].id, categories[1].id] }),
  });
  check('categories reorder', res.status === 200);

  res = await fetch(`${BASE}/api/categories`);
  body = await res.json();
  check(
    'the public list follows the owner ordering',
    body.categories[0]?.name === 'BGM',
    body.categories.map((c) => c.name).join(' > '),
  );

  section('Uploading');

  const audioBytes = mp3(40_000);
  const form = new FormData();
  form.append('audio', new Blob([audioBytes], { type: 'audio/mpeg' }), 'thalapathy theme.mp3');
  form.append('cover', new Blob([jpeg()], { type: 'image/jpeg' }), 'art.jpg');
  form.append(
    'metadata',
    JSON.stringify({
      title: 'Thalapathy Theme',
      artist: 'Anirudh',
      categoryId: categories[0].id,
      type: 'ringtone',
      tags: ['vijay', 'mass'],
      isPublished: true,
      durationSec: 42,
    }),
  );

  res = await req('/api/admin/audio', { method: 'POST', body: form });
  body = await res.json();
  check('an upload succeeds', res.status === 201, JSON.stringify(body).slice(0, 300));
  const track = body.audio;
  check('the response carries no storage detail', !JSON.stringify(body).toLowerCase().includes('telegram'));
  check('artwork is attached', track?.coverUrl === `/api/audio/${track?.id}/cover`);

  const second = new FormData();
  second.append('audio', new Blob([mp3(12_000)], { type: 'audio/mpeg' }), 'sad-bgm.mp3');
  second.append(
    'metadata',
    JSON.stringify({ title: 'Sad BGM', categoryId: categories[2].id, type: 'bgm', isPublished: true }),
  );
  res = await req('/api/admin/audio', { method: 'POST', body: second });
  check('a second upload succeeds', res.status === 201);

  const spoofed = new FormData();
  spoofed.append('audio', new Blob([Buffer.from('#!/bin/sh\nrm -rf /\n')], { type: 'audio/mpeg' }), 'evil.mp3');
  spoofed.append('metadata', JSON.stringify({ title: 'Evil' }));
  res = await req('/api/admin/audio', { method: 'POST', body: spoofed });
  check('a script renamed to .mp3 is rejected', res.status === 415, `got ${res.status}`);

  section('Playing and downloading');

  res = await fetch(`${BASE}${track.streamUrl}`);
  const streamed = Buffer.from(await res.arrayBuffer());
  check(
    'the whole file streams back byte for byte',
    res.status === 200 && Buffer.compare(streamed, audioBytes) === 0,
    `${res.status}, ${streamed.length} of ${audioBytes.length}`,
  );
  check('range support is advertised', res.headers.get('accept-ranges') === 'bytes');

  res = await fetch(`${BASE}${track.streamUrl}`, { headers: { range: 'bytes=1000-1999' } });
  const ranged = Buffer.from(await res.arrayBuffer());
  check(
    'a range request returns exactly those bytes',
    res.status === 206 && Buffer.compare(ranged, audioBytes.subarray(1000, 2000)) === 0,
    `${res.status} len=${ranged.length} range=${res.headers.get('content-range')}`,
  );

  res = await fetch(`${BASE}${track.streamUrl}`, { headers: { range: 'bytes=999999999-' } });
  check('an impossible range answers 416', res.status === 416, `got ${res.status}`);

  res = await fetch(`${BASE}${track.downloadUrl}`);
  const downloaded = Buffer.from(await res.arrayBuffer());
  const disposition = res.headers.get('content-disposition') ?? '';
  check('the download matches the uploaded bytes', Buffer.compare(downloaded, audioBytes) === 0);
  check(
    'the download is an attachment with a clean filename',
    disposition.includes('attachment') && disposition.includes('thalapathy-theme.mp3'),
    disposition,
  );
  check('the download does not redirect', res.redirected === false && res.headers.get('location') === null);

  const headerText = [...res.headers.entries()].map(([k, v]) => `${k}:${v}`).join('\n').toLowerCase();
  check(
    'no header mentions the storage backend',
    !headerText.includes('telegram') && !headerText.includes('t.me') && !headerText.includes('e2e-bot-token'),
  );

  res = await fetch(`${BASE}${track.streamUrl}`);
  const etag = res.headers.get('etag');
  await res.arrayBuffer();
  res = await fetch(`${BASE}${track.streamUrl}`, { headers: { 'if-none-match': etag } });
  check('a repeat request revalidates with 304', res.status === 304);

  res = await fetch(`${BASE}/api/audio/${track.id}/cover`);
  check('artwork is served', res.status === 200 && (res.headers.get('content-type') ?? '').startsWith('image/'));

  section('Public pages show the library');

  res = await fetch(`${BASE}/`);
  html = await res.text();
  check('the homepage lists the track', html.includes('Thalapathy Theme'));
  check('the homepage lists the categories', html.includes('Tamil OGs') && html.includes('BGM'));
  check('the homepage HTML says nothing about the storage backend', !html.toLowerCase().includes('telegram'));
  check('the bot token appears nowhere in the HTML', !html.includes('E2E-BOT-TOKEN'));

  res = await fetch(`${BASE}/category/${categories[0].slug}`);
  html = await res.text();
  check('the category page lists its track', res.status === 200 && html.includes('Thalapathy Theme'));

  res = await fetch(`${BASE}/song/${track.slug}`);
  html = await res.text();
  check('the song page renders', res.status === 200 && html.includes('Thalapathy Theme'));
  check('the song page carries structured data', html.includes('MusicRecording'));
  check('the song page carries canonical and Open Graph tags', html.includes('rel="canonical"') && html.includes('og:title'));
  check('the song page leaks nothing about storage', !html.toLowerCase().includes('telegram'));

  res = await fetch(`${BASE}/api/search?q=anirudh`);
  body = await res.json();
  check('search finds a track by artist', res.status === 200 && body.results.length === 1);

  res = await fetch(`${BASE}/search?q=thalapathy`);
  html = await res.text();
  check('the search page renders results server-side', res.status === 200 && html.includes('Thalapathy Theme'));

  res = await fetch(`${BASE}/sitemap.xml`);
  const sitemap = await res.text();
  check(
    'the sitemap lists the song and the category',
    sitemap.includes(`/song/${track.slug}`) && sitemap.includes(`/category/${categories[0].slug}`),
  );

  section('Unpublishing hides a track everywhere');

  res = await req(`/api/admin/audio/${track.id}?action=publish&value=false`, { method: 'PATCH' });
  check('unpublish succeeds', res.status === 200);

  res = await fetch(`${BASE}${track.streamUrl}`);
  check('an unpublished track no longer streams', res.status === 404);
  res = await fetch(`${BASE}${track.downloadUrl}`);
  check('an unpublished track no longer downloads', res.status === 404);
  res = await fetch(`${BASE}/song/${track.slug}`);
  check('the song page becomes a 404', res.status === 404, `got ${res.status}`);
  res = await fetch(`${BASE}/api/search?q=thalapathy`);
  body = await res.json();
  check('it drops out of search', body.results.length === 0);

  await req(`/api/admin/audio/${track.id}?action=publish&value=true`, { method: 'PATCH' });

  section('Admin diagnostics');

  res = await req('/api/admin/analytics');
  body = await res.json();
  check('analytics counts the download', res.status === 200 && body.stats.totalDownloads >= 1, JSON.stringify(body.stats));

  res = await req('/api/admin/storage');
  body = await res.json();
  check('storage reports the configured mode', body.mode === 'local-server', body.mode);
  check('the media cache is warm', body.cache.files >= 1, JSON.stringify(body.cache));
  check('nothing is left unreconciled', body.orphans.length === 0, JSON.stringify(body.orphans));

  section('Cross-site protection');

  res = await fetch(`${BASE}/api/admin/categories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader(), origin: BASE },
    body: JSON.stringify({ name: 'No CSRF Token' }),
  });
  check('a write without the CSRF token is refused', res.status === 403);

  res = await fetch(`${BASE}/api/admin/categories`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(),
      origin: 'https://evil.example',
      'x-montsong-csrf': decodeURIComponent(jar.get('montsong_csrf')),
    },
    body: JSON.stringify({ name: 'Cross Site' }),
  });
  check('a cross-origin write is refused', res.status === 403);

  section('Deleting a category keeps its tracks');

  res = await req(`/api/admin/categories/${categories[0].id}?mode=reassign&target=${categories[1].id}`, {
    method: 'DELETE',
  });
  body = await res.json();
  check('the tracks are moved, not deleted', res.status === 200 && body.movedAudio === 1, JSON.stringify(body));

  res = await fetch(`${BASE}/song/${track.slug}`);
  check('the track survives its category being deleted', res.status === 200);

  section('Signing out');

  res = await req('/api/admin/auth/logout', { method: 'POST' });
  check('sign out succeeds', res.status === 200);
  res = await req('/api/admin/categories');
  check('the session is dead afterwards', res.status === 401);
}

try {
  await main();
} catch (error) {
  console.error(`\nThe end-to-end run failed to complete:\n${error.stack ?? error}`);
  failures += 1;
} finally {
  cleanup();
}

console.log(`\n${failures === 0 ? 'All end-to-end checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
