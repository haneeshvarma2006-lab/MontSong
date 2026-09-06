# Deployment

MontSong needs one thing from its host: **a long-running Node process with a
persistent disk.** Everything else follows from that.

---

## Why not Vercel (or any serverless platform)

Worth stating plainly, because it is the default answer for a Next.js app and it
is the wrong one here. Three independent blockers:

1. **Upload size.** Serverless function request bodies are capped — 4.5 MB on
   Vercel. A 15 MB track cannot reach the handler at all. There is no
   configuration that lifts this; the platform rejects the request before your
   code runs.
2. **No persistent disk.** The media cache and the SQLite database both need a
   filesystem that survives between requests. Serverless filesystems are
   ephemeral and per-invocation. Without the cache, every play and every seek
   becomes a fresh Telegram fetch, which will hit rate limits and feel slow.
3. **Execution time.** Proxying a large file to a slow mobile connection can
   hold a response open for minutes. Serverless functions have hard timeouts.

You could work around all three — direct-to-storage uploads, external object
storage, a managed database — but that is a different, larger architecture for
no benefit at this size. **A single small container with a volume is the right
shape**, and it is cheap.

**Hosts that fit:** Fly.io (with a volume), Railway, Render, Hetzner, DigitalOcean,
a Raspberry Pi on a home connection, or any VPS. 512 MB of RAM is comfortable;
the process streams rather than buffers, so memory use barely moves with file
size.

---

## Docker (recommended)

Everything mutable lives under `/data`, mounted as a volume. Back that up and
you have backed up everything the site cannot rebuild.

```bash
cp .env.example .env
npm run auth:secret       # paste AUTH_SECRET into .env
npm run admin:password    # paste ADMIN_PASSWORD_HASH into .env
# fill in TELEGRAM_BOT_TOKEN and TELEGRAM_STORAGE_CHAT_ID — see TELEGRAM_SETUP.md

docker compose up --build -d
docker compose logs -f
```

The container applies pending migrations on start and then serves. `prisma
migrate deploy` only applies migrations that already exist and never resets a
database, so it is safe to run unattended on every restart.

Add starter categories once, if you want them:

```bash
docker compose exec montsong npm run db:seed
```

> **`NEXT_PUBLIC_SITE_URL` is baked in at build time.** It ends up in the client
> bundle, so changing it means rebuilding the image, not just restarting the
> container. Set it to your real public URL before the first build.

---

## Behind a reverse proxy

Terminate TLS at the proxy and forward to the container. Two headers matter:

- **`X-Forwarded-Proto`** — the application uses it to work out its own origin
  for the admin CSRF check. Without it, admin writes are rejected.
- **`X-Forwarded-For`** — used for per-address rate limiting. Without it, all
  clients share one bucket, which still limits but far less precisely.

### Caddy

Caddy handles certificates automatically and sets both headers itself:

```caddyfile
music.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name music.example.com;

    ssl_certificate     /etc/letsencrypt/live/music.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/music.example.com/privkey.pem;

    # Uploads are streamed straight to disk, so nginx must not buffer them
    # into a temp file first — and must not cap them below the app's own limit.
    client_max_body_size 512M;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Audio responses are streamed; buffering them defeats seeking and
        # adds latency to the first byte.
        proxy_buffering off;

        # A slow phone downloading a large file can hold the connection open.
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

---

## Without Docker

```bash
git clone <repository> && cd MontSong
npm ci --omit=dev
cp .env.example .env      # fill it in

npx prisma generate
npx prisma migrate deploy
npm run build
npm start
```

Keep it running with systemd:

```ini
# /etc/systemd/system/montsong.service
[Unit]
Description=MontSong
After=network.target

[Service]
Type=simple
User=montsong
WorkingDirectory=/srv/montsong
EnvironmentFile=/srv/montsong/.env
ExecStartPre=/usr/bin/npx prisma migrate deploy
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

# The process only needs to write to its own data directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/montsong/data /srv/montsong/media-cache /srv/montsong/tmp-uploads

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now montsong
sudo journalctl -u montsong -f
```

---

## Configuration reference

Every value is documented in [`.env.example`](../.env.example). The ones that
must be set:

| Variable | Notes |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | From @BotFather. Secret. |
| `TELEGRAM_STORAGE_CHAT_ID` | The private channel's numeric id, starting `-100`. |
| `ADMIN_USERNAME` | The owner's login name. |
| `ADMIN_PASSWORD_HASH` | From `npm run admin:password`. Never the password itself. |
| `AUTH_SECRET` | From `npm run auth:secret`. 32+ bytes, base64. |
| `NEXT_PUBLIC_SITE_URL` | Public origin. **Build-time**; rebuild after changing. |
| `DATABASE_URL` | `file:/data/montsong.db` in the container. |

> **Never put a bare `$` in a `.env` value.** Env-file loaders expand `$NAME`
> inside values. This is why the password hash uses `:` separators. If you
> generate a secret containing `$` by other means, quote it carefully or
> regenerate it.

---

## Backup

Three things matter, in descending order:

1. **Telegram** holds the audio. It is already off-site, replicated by
   Telegram, and survives losing the server entirely.
2. **The database** holds everything that makes those files a library — titles,
   categories, ordering, counts, and the identifiers that point at each file.
   **Losing it means the audio still exists but nothing knows what it is.**
   This is the thing to back up.
3. **The media cache** is disposable. It rebuilds itself on demand.

### Backing up the database

SQLite in WAL mode must not be copied with `cp` while the app is running — you
would get a torn read. Use SQLite's own online backup:

```bash
# In the container
docker compose exec montsong \
  sh -c 'npx prisma db execute --stdin <<< ".backup /data/backup.db"' \
  || docker compose exec montsong sqlite3 /data/montsong.db ".backup '/data/backup.db'"

# Or, without the container, the simplest reliable route:
sqlite3 /srv/montsong/data/montsong.db ".backup '/srv/backups/montsong-$(date +%F).db'"
```

A daily cron job keeping 30 days is proportionate for a personal library:

```cron
0 4 * * * sqlite3 /srv/montsong/data/montsong.db ".backup '/srv/backups/montsong-$(date +\%F).db'" && find /srv/backups -name 'montsong-*.db' -mtime +30 -delete
```

Copy the result off the machine — the point of a backup is surviving the loss of
the machine.

### Restoring

```bash
sudo systemctl stop montsong          # or: docker compose stop

cp /srv/backups/montsong-2026-09-01.db /srv/montsong/data/montsong.db
rm -f /srv/montsong/data/montsong.db-wal /srv/montsong/data/montsong.db-shm

sudo systemctl start montsong
```

The media cache repopulates itself from Telegram as tracks are played. Nothing
else needs restoring.

**Test a restore before you need one.** Restore into a scratch directory, start
the app against it, and confirm a track plays.

---

## Upgrading

```bash
git pull
npm ci
npx prisma migrate deploy   # applies any new migrations
npm run build
sudo systemctl restart montsong
```

Or, with Docker:

```bash
git pull
docker compose up --build -d
```

Take a database backup first. Migrations are forward-only.

---

## Operating notes

**Health check.** `GET /api/categories` returns `200` with JSON whenever the
app and database are healthy. The Docker image uses it.

**Logs** are one JSON object per line — parseable by any log driver. The bot
token is redacted defensively from every logged string. `LOG_LEVEL` accepts
`debug`, `info`, `warn`, `error`; production defaults to `info`. Set
`TELEGRAM_DEBUG=true` to log every Bot API call's method and status (never its
token) while diagnosing a storage problem.

**Disk.** The volume holds the database (a few MB for thousands of tracks), the
media cache (bounded by `MEDIA_CACHE_MAX_BYTES`, 2 GiB by default) and the
upload spool (transient). Budget the cache limit plus a gigabyte.

**Memory.** Uploads and downloads are streamed, so file size barely affects
memory. 512 MB is comfortable.

**If the cache directory fills or gets corrupted,** delete it. It rebuilds. The
Storage screen has a button for this.

**If you see unfinished uploads on the Storage screen,** each one is a file that
reached Telegram but never became a track — usually a crash or restart mid-upload.
Recover turns it into a usable file without re-uploading; Discard deletes it.
Neither is urgent.
