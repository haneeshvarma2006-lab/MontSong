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

Create your configuration:

```bash
cp .env.example .env
npm run auth:secret      # prints AUTH_SECRET=...      → paste into .env
npm run admin:password   # asks for a password, prints ADMIN_PASSWORD_HASH=... → paste into .env
```

Then fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_STORAGE_CHAT_ID` from
[docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md).

Set up the database and start:

```bash
npm run db:migrate       # creates data/montsong.db
npm run db:seed          # optional: a starter set of categories
npm run dev
```

Open <http://localhost:3000>. The admin is at
<http://localhost:3000/admin>, using `ADMIN_USERNAME` and the password you
just hashed.

First thing to check: **Admin → Storage → Test connection**. It verifies the
token, finds the channel, and confirms the bot may post there. If that passes,
uploads will work.

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
