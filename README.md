# MontSong

A fast, minimal music and ringtone library. Songs, ringtones and BGM organised
into categories the owner defines, played and downloaded straight from the site.

The files live in a private Telegram channel. Visitors never see that: they
press play, the audio streams from this origin; they press download, the file
arrives from this origin. No Telegram app, no Telegram account, no redirect.

```
Browser  →  MontSong  →  Telegram Bot API  →  private channel
   ↑            │
   └────────────┘   bytes come back through the site, never from Telegram directly
```

---

## What it does

**For visitors**

- Browse categories, search by title, artist, category or tag
- Play anything in a persistent bottom player that survives navigation
- Download any track with one tap, named sensibly (`tamil-og-ringtone.mp3`)
- Works on a phone; no account, no sign-up, no autoplay, no popups

**For the owner**

- One login. Everything else is closed, enforced on the server.
- Create, rename, reorder, hide and delete categories — nothing is hardcoded
- Upload audio with artwork, tags and metadata; publish or keep as a draft
- Move tracks between categories, reorder them, edit anything later
- See download and play counts, and a 30-day chart
- Diagnose storage: test the connection, watch the cache, recover any upload
  that reached storage but did not finish

---

## See it first, without a Telegram bot

If you don't have a bot yet — or just want to look around — you don't need one:

```bash
npm install
npm run preview
```

That starts the site at <http://localhost:3000> with a demo library already in
it, and prints the admin sign-in details. Everything works: browsing, search,
playing, seeking, downloading, and the full admin including uploading your own
audio files.

Storage is a stand-in that runs on your own machine for the length of the
session — no bot, no Telegram account, nothing leaves your computer. Uploads
live in that process's memory and disappear when you stop it.

| | |
| --- | --- |
| `npm run preview` | Start it (builds first, about 20 seconds) |
| `npm run preview -- --fresh` | Wipe the demo library and rebuild it |
| `npm run preview -- --port 4000` | Use a different port |
| Ctrl-C | Stop |

The workspace lives in `.preview/` and is gitignored; delete it to reset.
When your bot is ready, follow the setup below — the preview never touches
your real `.env` or database.

---

## Requirements

- **Node.js 20.11 or newer** (22 recommended)
- **A Telegram bot** and a **private channel** for it to post into —
  see [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md), about five minutes
- Nothing else. No database server, no object storage, no Redis.

---

## Getting started

```bash
git clone <this repository>
cd MontSong
npm install
```

Then configure it:

```bash
npm run setup
```

It asks for your bot token, your channel id and a password, generates the
secrets you should never pick by hand, writes `.env`, applies the database
schema, and then actually calls Telegram to check the credentials before
telling you they work — confirming the token, that the channel exists, and
that the bot is allowed to post to it.

Re-run it any time. Existing values become the defaults, so pressing Enter
through it changes nothing, and the check at the end is a quick diagnostic
when something has stopped working.

Then start it:

```bash
npm run build && npm start
```

Open <http://localhost:3000>, and sign in at <http://localhost:3000/admin>
with the username and password you just chose. Add a category, then upload
your first track.

<details>
<summary>Configuring it by hand instead</summary>

```bash
cp .env.example .env
npm run auth:secret      # prints AUTH_SECRET=...            → paste into .env
npm run admin:password   # prints ADMIN_PASSWORD_HASH=...    → paste into .env
```

Fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_STORAGE_CHAT_ID` from
[docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md), then:

```bash
npm run db:migrate       # creates data/montsong.db
npm run db:seed          # optional: a starter set of categories
npm run dev
```

Check **Admin → Storage → Test connection** afterwards; it runs the same
checks `npm run setup` does.

</details>

---

## The one limitation worth knowing about

Telegram's cloud Bot API lets a bot **send** files up to 50 MB but only lets it
**fetch back** files up to 20 MB. Since this site has to serve every file back
to a visitor, **20 MB is the real ceiling** — a larger upload would succeed and
then be permanently unplayable. Uploads are capped accordingly, and the cap is
shown on the upload screen.

For songs and ringtones this is rarely a constraint: a five-minute track at
320 kbps is about 12 MB, and a ringtone is one or two.

If you do need more, run a [local Bot API server][local-server] and point
`TELEGRAM_API_BASE_URL` at it. That raises uploads to 2000 MB and removes the
download limit entirely. It is Telegram's own software, not a workaround.
[docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md) has the details.

[local-server]: https://github.com/tdlib/telegram-bot-api

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup` | Configure `.env`, apply the schema, verify Telegram — re-runnable |
| `npm run preview` | The whole site with a demo library, no Telegram bot needed |
| `npm run dev` | Development server on :3000 |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run verify` | Lint, typecheck, tests, build, end-to-end — the full gate |
| `npm test` | Unit and integration tests |
| `npm run test:e2e` | Builds and drives a real server over HTTP |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm run db:migrate` | Create and apply a migration (development) |
| `npm run db:deploy` | Apply existing migrations (production) |
| `npm run db:studio` | Browse the database |
| `npm run db:seed` | Add starter categories (idempotent) |
| `npm run admin:password` | Generate `ADMIN_PASSWORD_HASH` |
| `npm run auth:secret` | Generate `AUTH_SECRET` |

---

## Documentation

| | |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | How it is put together, and why — storage, caching, streaming, the data model, and the decisions behind them |
| [Telegram setup](docs/TELEGRAM_SETUP.md) | Creating the bot and channel, finding the chat id, the real API limits, running a local Bot API server |
| [Deployment](docs/DEPLOYMENT.md) | Docker, a VPS, backups, restores, upgrades — and why serverless is the wrong shape for this |
| [Security](docs/SECURITY.md) | The threat model, what is defended and how, and the review that was done |

---

## Project layout

```
prisma/schema.prisma      the data model
src/app/                  pages and API routes
  api/audio/[id]/         stream, download and cover endpoints
  api/admin/              the owner's API, closed to everyone else
  admin/                  the admin interface
src/components/           UI, including the player and its store
src/lib/
  telegram/               the Bot API client and the storage service
  media/                  content sniffing, range parsing, caching, serving
  auth/                   passwords, sessions, CSRF, rate limiting
  upload/                 streaming multipart spooling, the commit pipeline
  repositories/           database access, one module per concern
tests/
  unit/                   pure logic
  integration/            real route handlers against a stand-in Bot API
  e2e/                    a real server, driven over HTTP
docs/                     the documents listed above
```

---

## Licence

Private project. All rights reserved by the owner.
