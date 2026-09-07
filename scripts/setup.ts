/**
 * One-command setup.
 *
 *   npm run setup
 *
 * Asks for the two Telegram values and a password, generates the secrets that
 * should never be chosen by hand, writes .env, applies migrations, and then
 * actually calls the Bot API to prove the credentials work before telling you
 * they do.
 *
 * Everything is re-runnable. Existing values become the defaults, so pressing
 * Enter through the whole thing changes nothing, and the connection test at
 * the end doubles as a diagnostic when something has stopped working.
 *
 * Secrets are read from the terminal without echoing and never passed as
 * command-line arguments, so they stay out of shell history and out of the
 * process list.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';

import { hashPassword } from '../src/lib/auth/password.ts';

const ENV_PATH = path.resolve(process.cwd(), '.env');

const bold = (s: string) => `[1m${s}[0m`;
const dim = (s: string) => `[2m${s}[0m`;
const green = (s: string) => `[32m${s}[0m`;
const red = (s: string) => `[31m${s}[0m`;
const yellow = (s: string) => `[33m${s}[0m`;

// --- .env read/write --------------------------------------------------------

/**
 * Parse just enough dotenv to round-trip a file we wrote. Values are stored
 * quoted, and no shell expansion is applied — the same assumption Next.js
 * makes when it loads .env, and the reason password hashes use `:` separators
 * rather than `$`.
 */
function readEnvFile(file: string): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(file)) return values;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function writeEnvFile(file: string, values: Map<string, string>): void {
  const line = (key: string) => `${key}="${values.get(key) ?? ''}"`;

  const body = `# MontSong configuration — written by \`npm run setup\`.
#
# Real secrets live here. .gitignore already excludes this file; keep it that
# way. To change anything, re-run \`npm run setup\`.

DATABASE_URL="${values.get('DATABASE_URL') ?? 'file:./data/montsong.db'}"

# --- Telegram storage -------------------------------------------------------
${line('TELEGRAM_BOT_TOKEN')}
${line('TELEGRAM_STORAGE_CHAT_ID')}
# Unset means the cloud Bot API (https://api.telegram.org), which can serve
# back files up to 20 MB. Point this at your own tdlib/telegram-bot-api server
# to raise that — see docs/TELEGRAM_SETUP.md.
${values.has('TELEGRAM_API_BASE_URL') ? line('TELEGRAM_API_BASE_URL') : '# TELEGRAM_API_BASE_URL="http://127.0.0.1:8081"'}
${values.has('TELEGRAM_API_LOCAL_MODE') ? line('TELEGRAM_API_LOCAL_MODE') : '# TELEGRAM_API_LOCAL_MODE="false"'}

# --- Admin sign-in ----------------------------------------------------------
${line('ADMIN_USERNAME')}
${line('ADMIN_PASSWORD_HASH')}
# Changing AUTH_SECRET signs out every existing session.
${line('AUTH_SECRET')}

# --- Site -------------------------------------------------------------------
${line('NEXT_PUBLIC_SITE_URL')}
${line('NEXT_PUBLIC_SITE_NAME')}

# --- Storage paths ----------------------------------------------------------
${line('MEDIA_CACHE_DIR')}
${line('UPLOAD_TMP_DIR')}
`;

  // 0600: the token and the auth secret are in here.
  writeFileSync(file, body, { mode: 0o600 });
}

// --- prompting --------------------------------------------------------------

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/** Prompt without echoing, so the value stays out of the scrollback. */
function askSecret(rl: Interface, question: string): Promise<string> {
  process.stdout.write(question);
  const output = rl as unknown as { _writeToOutput?: unknown };
  const restore = output._writeToOutput;
  output._writeToOutput = () => {};

  return new Promise((resolve) => {
    rl.question('', (answer) => {
      output._writeToOutput = restore;
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/** Show enough of a secret to recognise it, never enough to use it. */
function mask(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}${'•'.repeat(6)}${value.slice(-2)}`;
}

async function askWithDefault(
  rl: Interface,
  label: string,
  current: string | undefined,
  { secret = false, validate }: { secret?: boolean; validate?: (v: string) => string | null } = {},
): Promise<string> {
  for (;;) {
    const shown = current ? ` ${dim(`[${secret ? mask(current) : current}]`)}` : '';
    const question = `${label}${shown}: `;
    const answer = (secret ? await askSecret(rl, question) : await ask(rl, question)).trim();

    const value = answer === '' ? (current ?? '') : answer;
    if (value === '') {
      console.log(red('  This one is required.'));
      continue;
    }
    const problem = validate?.(value);
    if (problem) {
      console.log(red(`  ${problem}`));
      continue;
    }
    return value;
  }
}

// --- validation -------------------------------------------------------------

function validateToken(value: string): string | null {
  // BotFather issues "<bot id>:<35-char secret>". Catching a mistyped token
  // here is far kinder than a 401 three steps later.
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(value)) {
    return 'That does not look like a bot token. It should look like 8123456789:AAH8k2Lm... — copy the whole line BotFather sent.';
  }
  return null;
}

function validateChatId(value: string): string | null {
  if (!/^-?\d+$/.test(value)) return 'A chat id is a number, e.g. -1001234567890.';
  if (value.startsWith('-100')) return null;
  if (value.startsWith('-')) {
    return 'That looks like an old-style group id. Use a channel — its id starts with -100. See docs/TELEGRAM_SETUP.md step 2.';
  }
  return 'That is a personal chat id, not a channel. A private channel is safer and its id starts with -100. See docs/TELEGRAM_SETUP.md step 2.';
}

// --- the connection test ----------------------------------------------------

interface CheckResult {
  ok: boolean;
  lines: string[];
}

/**
 * Call the Bot API directly rather than through the application client: this
 * runs before the app has ever been started, and a plain fetch keeps the
 * failure modes obvious.
 */
async function checkTelegram(token: string, chatId: string, baseUrl: string): Promise<CheckResult> {
  const lines: string[] = [];

  const call = async (
    method: string,
    body?: Record<string, string>,
  ):
    | Promise<
        | { ok: true; result: Record<string, unknown> }
        | { ok: false; reason: string; unreachable: boolean }
      > => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/bot${token}/${method}`, {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        unreachable: true,
        reason: `could not reach ${baseUrl} (${detail})`,
      };
    }

    let payload: { ok?: boolean; result?: Record<string, unknown>; description?: string };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      // The Bot API always answers JSON, even for its own errors. Anything
      // else means the request never got there.
      return {
        ok: false,
        unreachable: true,
        reason: `something on the network answered instead of the Bot API (HTTP ${response.status})`,
      };
    }

    if (!payload.ok || !payload.result) {
      return {
        ok: false,
        unreachable: false,
        reason: payload.description ?? `HTTP ${response.status}`,
      };
    }
    return { ok: true, result: payload.result };
  };

  const me = await call('getMe');
  if (!me.ok) {
    // Distinguishing these two matters. Telling someone to re-check a token
    // that is perfectly correct, when the real problem is that the machine
    // cannot reach the internet, costs them the whole evening.
    if (me.unreachable) {
      lines.push(red(`  ✗ Could not reach Telegram: ${me.reason}`));
      lines.push(dim('    Your token and channel id are probably fine — the request never'));
      lines.push(dim('    left this machine. Check the internet connection, DNS, and any'));
      lines.push(dim('    proxy, firewall or VPN. Company and campus networks often block it.'));
    } else {
      lines.push(red(`  ✗ The bot token was rejected: ${me.reason}`));
      lines.push(dim('    Re-check TELEGRAM_BOT_TOKEN, or get a fresh one from @BotFather.'));
    }
    return { ok: false, lines };
  }
  lines.push(green(`  ✓ Bot token works — signed in as @${String(me.result.username)}`));

  const chat = await call('getChat', { chat_id: chatId });
  if (!chat.ok) {
    lines.push(red(`  ✗ Could not open the storage channel: ${chat.reason}`));
    if (!chat.unreachable) {
      lines.push(
        dim('    Check TELEGRAM_STORAGE_CHAT_ID, and that the bot is an administrator of it.'),
      );
    }
    return { ok: false, lines };
  }

  const title = typeof chat.result.title === 'string' ? chat.result.title : chatId;
  const type = String(chat.result.type);
  lines.push(green(`  ✓ Storage channel found — "${title}"`));

  if (type === 'private') {
    lines.push(
      yellow('  ! That is a private chat, not a channel. It works, but a channel is safer:'),
    );
    lines.push(dim('    clearing your own chats cannot take the library with it.'));
  }

  // Posting rights are the thing that actually breaks uploads, and getChat
  // does not report them. Ask what this bot may do in that chat.
  const member = await call('getChatMember', { chat_id: chatId, user_id: String(me.result.id) });
  if (member.ok) {
    const status = String(member.result.status);
    const canPost = member.result.can_post_messages;
    if (status !== 'administrator' && status !== 'creator') {
      lines.push(red(`  ✗ The bot is not an administrator of that channel (status: ${status}).`));
      lines.push(dim('    Channel → Administrators → Add Admin → your bot, with "Post Messages".'));
      return { ok: false, lines };
    }
    if (canPost === false) {
      lines.push(red('  ✗ The bot is an administrator but may not post messages.'));
      lines.push(dim('    Enable "Post Messages" in its administrator rights.'));
      return { ok: false, lines };
    }
    lines.push(green('  ✓ The bot may post to it'));
    if (member.result.can_delete_messages === false) {
      lines.push(
        yellow('  ! It may not delete messages, so deleting a track will leave the file behind.'),
      );
      lines.push(dim('    Enable "Delete Messages" to let the site clean up storage. Optional.'));
    }
  }

  return { ok: true, lines };
}

// --- steps ------------------------------------------------------------------

function run(command: string, args: string[], label: string): boolean {
  const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8' });
  if (result.status === 0) {
    console.log(green(`  ✓ ${label}`));
    return true;
  }
  console.log(red(`  ✗ ${label}`));
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  for (const line of output.split('\n').slice(-8)) console.log(dim(`    ${line}`));
  return false;
}

async function main(): Promise<void> {
  const existing = readEnvFile(ENV_PATH);
  const isFirstRun = existing.size === 0;

  console.log('');
  console.log(bold(isFirstRun ? 'Setting up MontSong' : 'Updating your MontSong configuration'));
  console.log(
    dim(
      isFirstRun
        ? 'Four questions, then this configures and checks everything.'
        : 'Press Enter to keep any existing value.',
    ),
  );
  console.log('');
  console.log(dim('You need a bot token and a channel id — docs/TELEGRAM_SETUP.md has both,'));
  console.log(dim('or run `npm run preview` to look around the site without them.'));
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  try {
    const token = await askWithDefault(rl, 'Telegram bot token', existing.get('TELEGRAM_BOT_TOKEN'), {
      secret: true,
      validate: validateToken,
    });

    const chatId = await askWithDefault(
      rl,
      'Storage channel id',
      existing.get('TELEGRAM_STORAGE_CHAT_ID'),
      { validate: validateChatId },
    );

    const username = await askWithDefault(
      rl,
      'Admin username',
      existing.get('ADMIN_USERNAME') ?? 'owner',
    );

    // Keeping the existing hash is what makes a re-run safe to Enter through.
    let passwordHash = existing.get('ADMIN_PASSWORD_HASH') ?? '';
    const wantsNewPassword =
      passwordHash === '' ||
      (await ask(rl, `Change the admin password? ${dim('[y/N]')} `)).trim().toLowerCase() === 'y';

    if (wantsNewPassword) {
      for (;;) {
        const password = await askSecret(rl, 'Admin password (at least 12 characters): ');
        if (password.trim().length < 12) {
          console.log(red('  Too short — 12 characters minimum.'));
          continue;
        }
        const again = await askSecret(rl, 'Type it again: ');
        if (password !== again) {
          console.log(red('  Those did not match.'));
          continue;
        }
        process.stdout.write(dim('  hashing… '));
        passwordHash = await hashPassword(password);
        process.stdout.write('\n');
        break;
      }
    }

    const siteUrl = await askWithDefault(
      rl,
      'Public site URL',
      existing.get('NEXT_PUBLIC_SITE_URL') ?? 'http://localhost:3000',
    );

    const siteName = await askWithDefault(
      rl,
      'Site name',
      existing.get('NEXT_PUBLIC_SITE_NAME') ?? 'MontSong',
    );

    // --- write ---------------------------------------------------------------

    const values = new Map(existing);
    values.set('TELEGRAM_BOT_TOKEN', token);
    values.set('TELEGRAM_STORAGE_CHAT_ID', chatId);
    values.set('ADMIN_USERNAME', username);
    values.set('ADMIN_PASSWORD_HASH', passwordHash);
    values.set('NEXT_PUBLIC_SITE_URL', siteUrl.replace(/\/+$/, ''));
    values.set('NEXT_PUBLIC_SITE_NAME', siteName);
    values.set('DATABASE_URL', existing.get('DATABASE_URL') ?? 'file:./data/montsong.db');
    values.set('MEDIA_CACHE_DIR', existing.get('MEDIA_CACHE_DIR') ?? './media-cache');
    values.set('UPLOAD_TMP_DIR', existing.get('UPLOAD_TMP_DIR') ?? './tmp-uploads');

    // Regenerating this would sign out every existing session, so only ever
    // create it when there is nothing to preserve.
    if (!values.get('AUTH_SECRET')) {
      values.set('AUTH_SECRET', randomBytes(48).toString('base64'));
    }

    console.log('');
    console.log(bold('Writing configuration'));
    writeEnvFile(ENV_PATH, values);
    console.log(green(`  ✓ .env written (owner-readable only)`));

    // --- database ------------------------------------------------------------

    console.log('');
    console.log(bold('Preparing the database'));
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    if (!run(npx, ['prisma', 'generate'], 'Database client generated')) process.exitCode = 1;
    if (!run(npx, ['prisma', 'migrate', 'deploy'], 'Schema applied')) process.exitCode = 1;

    // --- storage -------------------------------------------------------------

    const baseUrl = (values.get('TELEGRAM_API_BASE_URL') ?? 'https://api.telegram.org').replace(
      /\/+$/,
      '',
    );

    console.log('');
    console.log(bold('Checking Telegram storage'));
    const check = await checkTelegram(token, chatId, baseUrl);
    for (const line of check.lines) console.log(line);

    // --- done ----------------------------------------------------------------

    console.log('');
    if (check.ok) {
      console.log(green(bold('Ready.')));
      console.log('');
      console.log('  Start it:            ' + bold('npm run build && npm start'));
      console.log('  Then open:           ' + bold(values.get('NEXT_PUBLIC_SITE_URL') ?? ''));
      console.log(
        '  Sign in at /admin:   ' + bold(username) + dim('  (the password you just set)'),
      );
      console.log('');
      console.log(dim('  Add some categories first, then upload your first track.'));
    } else {
      console.log(yellow(bold('Configuration written, but storage is not working yet.')));
      console.log('');
      console.log(dim('  Nothing else is wrong — fix the item above and run this again:'));
      console.log('  ' + bold('npm run setup'));
      console.log('');
      console.log(dim('  docs/TELEGRAM_SETUP.md walks through each of these.'));
      process.exitCode = 1;
    }
    console.log('');
  } finally {
    rl.close();
  }
}

void main();
