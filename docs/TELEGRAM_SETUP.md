# Telegram setup

Five minutes, once. You need two things: a bot token and the numeric id of a
private channel the bot can post into.

Nothing here is exposed to visitors. The token lives in an environment variable
on the server and is never sent to a browser.

> **Not ready to make a bot yet?** `npm run preview` runs the entire site
> against a stand-in storage service on your own machine — browse, play,
> download, upload, everything — with no bot and no Telegram account. See the
> README. Come back here when you are ready to store files for real.

---

## 1. Create the bot

1. Open Telegram and message [**@BotFather**](https://t.me/BotFather).
2. Send `/newbot`.
3. Give it a display name (anything, e.g. "MontSong Storage").
4. Give it a username ending in `bot` (e.g. `montsong_storage_bot`).

BotFather replies with a token that looks like:

```
7123456789:AAH8k2LmQwErTyUiOpAsDfGhJkLzXcVbNm0
```

Put it in `.env`:

```dotenv
TELEGRAM_BOT_TOKEN="7123456789:AAH8k2LmQwErTyUiOpAsDfGhJkLzXcVbNm0"
```

> **Treat this like a password.** Anyone holding it can read and delete
> everything in the storage channel. Never commit it, never paste it into a
> chat or an issue. If it leaks, send `/revoke` to BotFather and generate a new
> one, then update the environment variable and restart.

---

## 2. Create the storage channel

A **private channel** is the right home for these files.

1. In Telegram: **New Channel**.
2. Name it something you will recognise — "MontSong Storage".
3. Set it to **Private**.
4. **Administrators → Add Admin →** search for your bot's username and add it.
   Leave "Post Messages" enabled; it needs that. Enabling "Delete Messages" as
   well lets the site clean up storage when you delete a track — recommended,
   though not required.

**Why a channel rather than a private chat with the bot?** A channel's history
belongs to the channel, so clearing your own chats cannot take the library with
it, and you can add a second admin without handing over your account.

---

## 3. Find the channel's numeric id

Channel ids are negative and start with `-100`. Two ways to get it:

**The easy way.** Forward any message from the channel to
[**@userinfobot**](https://t.me/userinfobot) or
[**@getidsbot**](https://t.me/getidsbot). It replies with the id.

**Without a third-party bot.** Post any message in the channel, then open this
URL in a browser, substituting your token:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

Look for `"chat":{"id":-1001234567890,...}`. That number is the id.

> If `getUpdates` comes back empty, post a fresh message in the channel and
> reload — it only returns recent updates, and only if no webhook is set.

Put it in `.env`:

```dotenv
TELEGRAM_STORAGE_CHAT_ID="-1001234567890"
```

---

## 4. Verify

Start the site, sign in, and go to **Admin → Storage → Test connection**.

A pass tells you three things at once: the token is valid, the channel exists,
and the bot can see it. A failure names which of the three went wrong.

| What it says | What to do |
| --- | --- |
| "The media storage credentials were rejected" | The token is wrong or was revoked. Check `TELEGRAM_BOT_TOKEN`, or get a new one from BotFather. |
| "The configured storage chat could not be found" | The id is wrong, or the bot was never added to the channel. Re-check step 3, and confirm the bot is an administrator. |
| "The bot does not have permission to post" | Add it as an administrator with "Post Messages" enabled. |
| "The storage chat is a private chat" (warning) | It works, but a private channel is safer — see step 2. |
| "A network proxy or firewall refused to pass the request" | Nothing is wrong with your token or channel — the request never left the machine. The host running MontSong must be allowed to make outbound HTTPS requests to `api.telegram.org`. Common on locked-down company networks, some university Wi-Fi, and sandboxed CI runners. |
| "something on the network answered in its place" | Same class of problem: a captive portal, ISP landing page or transparent proxy replied instead of Telegram. Check the connection, DNS, and any proxy settings. |

---

## The API limits that shape this

Verified against Telegram's Bot API documentation, September 2026.

### Cloud Bot API — `api.telegram.org`

| | |
| --- | --- |
| Upload (`sendAudio`, `sendDocument`) | up to **50 MB** |
| Download (`getFile`) | up to **20 MB** |
| `getFile` link lifetime | guaranteed **at least one hour** |
| Rate limit | roughly **30 messages/second**; a `429` carries `retry_after` |

**The asymmetry is the whole story.** A bot may send a 50 MB file and then be
unable to fetch it back. This site has to fetch every file back — that is what
a download *is* — so the binding limit is 20 MB, not 50.

`MAX_AUDIO_UPLOAD_BYTES` is therefore clamped to 20 MB on the cloud API. Raising
it in `.env` does not raise the ceiling; the application clamps it at startup
and says so on the Storage screen. Accepting a 30 MB upload would mean storing a
track that can never be played.

**In practice:** a 5-minute MP3 at 320 kbps is ~12 MB; at 192 kbps, ~7 MB. A
30-second ringtone is 1–2 MB. Most libraries never touch the limit.

### Local Bot API server

Telegram publishes the Bot API server itself: [tdlib/telegram-bot-api][repo].
Running it with `--local` changes the limits:

| | |
| --- | --- |
| Upload | up to **2000 MB** |
| Download | **no size limit** |
| `getFile` | returns an absolute path on that machine, no HTTP fetch needed |

This is Telegram's own software, used as documented — not a workaround.

[repo]: https://github.com/tdlib/telegram-bot-api

**To use it:**

1. Get `api_id` and `api_hash` from <https://my.telegram.org/apps>.
2. Run the server (Docker is the easiest route):

   ```bash
   docker run -d --name telegram-bot-api \
     -p 127.0.0.1:8081:8081 \
     -v telegram-bot-api-data:/var/lib/telegram-bot-api \
     -e TELEGRAM_API_ID=<your api_id> \
     -e TELEGRAM_API_HASH=<your api_hash> \
     -e TELEGRAM_LOCAL=1 \
     aiogram/telegram-bot-api:latest
   ```

3. Point MontSong at it:

   ```dotenv
   TELEGRAM_API_BASE_URL="http://127.0.0.1:8081"
   TELEGRAM_API_LOCAL_MODE="true"
   MAX_AUDIO_UPLOAD_BYTES="524288000"   # 500 MB, or whatever you want
   ```

   `TELEGRAM_API_LOCAL_MODE=true` tells MontSong that `getFile` will return a
   filesystem path rather than a downloadable URL. **Only set it when the
   server actually runs with `--local` and shares a filesystem with MontSong**
   — if the two are in separate containers, either share a volume or leave this
   `false` so files are fetched over HTTP instead.

4. Restart and re-run the connection test. The Storage screen will report
   "Local Bot API server" and the new ceiling.

### What is deliberately not used

**MTProto** (the client API, via GramJS, Telethon and similar) would raise the
limits further, and bots can authenticate with it. It is not used here because
it is a substantially heavier client with a different auth model and session
state to manage, for a gain the local Bot API server already provides through a
supported, documented path.

No unofficial endpoints, no scraping, and no third-party file-hosting proxies
are used anywhere in this project.

---

## Rate limits and how they are handled

Telegram does not publish exact numbers. The well-established practical ceiling
is around 30 messages/second, and any call may answer `429` with a
`parameters.retry_after` telling you how long to wait.

The documented correct behaviour is to wait exactly that long and retry.
Ignoring it escalates the cooldown. `src/lib/telegram/client.ts` honours
`retry_after` on every call, retries `5xx` and transport failures with
exponential backoff, and never retries a deterministic `4xx`.

Two design choices keep the site far below any limit:

- **A resolved file location is cached for 45 minutes.** Telegram guarantees
  the `getFile` path for at least an hour; refreshing at 45 minutes means a busy
  track costs one `getFile` per 45 minutes rather than one per request.
- **Files are cached on disk.** After the first play, every subsequent play and
  every seek is served locally. A track that gets shared widely costs one
  Telegram transfer, not thousands.

---

## Where the files actually are

Each upload becomes one message in your private channel. You can open the
channel and see them; that is normal, and it is a useful backup view.

**Do not delete those messages by hand.** The site keeps a record pointing at
each one. Delete a track from **Admin → Songs** instead, and the message goes
with it. If a message does get deleted directly, playback for that track will
fail with a clear error, and you can delete or re-upload it from the admin.
