# MontSong

A music and ringtone library. The owner uploads tracks and sorts them into
categories they define; visitors browse, play and download them, mostly from a
phone.

Files are stored in a private Telegram channel — an implementation detail
visitors never meet. Audio streams and downloads are served from this origin,
so there is no Telegram app, account, redirect or manual download anywhere in
the experience, and the bot token never reaches a browser.

---

## Look at it without a Telegram bot

```bash
npm install
npm run preview
```

Serves the whole site at <http://localhost:3000> with a demo library and prints
the sign-in details. Browsing, search, playback, seeking, downloads and the full
admin all work, uploads included. Storage is a stand-in process on your own
machine; nothing leaves it, and uploads vanish when you stop it.

`npm run preview -- --fresh` rebuilds the demo library, `-- --port 4000` moves
it, Ctrl-C stops it.

---

## Running it for real

You need Node 20.11 or newer (22 recommended), a Telegram bot, and a private
channel for it to post into. [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md)
covers both, about five minutes.

```bash
npm install
npm run setup
npm run build && npm start
```

`setup` asks for the token, the channel id and a password; generates the
secrets that should not be chosen by hand; writes `.env`; applies the database
schema; then calls Telegram and tells you whether the token works, the channel
exists, and the bot may post to it. Re-run it whenever — existing values become
the defaults, so it doubles as a diagnostic when something breaks.

Then sign in at `/admin`, create a category, and upload a track.

---

## The limit worth knowing about

Telegram's cloud Bot API lets a bot **send** 50 MB but **fetch back** only
20 MB. Every file here has to be fetched back in order to serve it, so 20 MB is
the real ceiling and uploads are capped there. Without that cap a larger file
would upload successfully and then be permanently unplayable.

Rarely a constraint for this content — a five-minute 320 kbps track is about
12 MB, a ringtone one or two. If you do need more, point `TELEGRAM_API_BASE_URL`
at a [local Bot API server][local-server]: it is Telegram's own software, and it
raises uploads to 2000 MB and removes the download limit.

[local-server]: https://github.com/tdlib/telegram-bot-api

---

## Commands

| | |
| --- | --- |
| `npm run setup` | Configure, migrate and verify Telegram. Re-runnable |
| `npm run preview` | The whole site with a demo library, no bot needed |
| `npm run dev` | Development server |
| `npm run build && npm start` | Production |
| `npm run verify` | Lint, typecheck, tests, build, end-to-end — the full gate |
| `npm run db:deploy` | Apply migrations (production) |

The rest are in `package.json`.

---

## Documentation

| | |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | How it works and why — storage, caching, streaming, the data model, the trade-offs |
| [Telegram setup](docs/TELEGRAM_SETUP.md) | Bot, channel, chat id, the real API limits, running a local Bot API server |
| [Deployment](docs/DEPLOYMENT.md) | Docker, a VPS, backups, upgrades — and why serverless is the wrong shape for this |
| [Security](docs/SECURITY.md) | Threat model, what is defended and how |

---

## Licence

Private project. All rights reserved by the owner.
