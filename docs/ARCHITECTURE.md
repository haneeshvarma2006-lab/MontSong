# Architecture

How MontSong is put together, and why each significant choice was made.

---

## Shape

```
              ┌──────────────────────────────────────────┐
   visitor ──▶│  Next.js (App Router, Node runtime)      │
              │                                          │
              │  pages ──── server-rendered, SEO-ready   │
              │  /api/audio/:id/stream    ──┐            │
              │  /api/audio/:id/download  ──┤            │
              │  /api/admin/*  (closed)     │            │
              └─────────────────────────────┼────────────┘
                                            │
                          ┌─────────────────┴─────────────────┐
                          │                                   │
                   ┌──────▼───────┐                 ┌─────────▼─────────┐
                   │ SQLite       │                 │ media cache       │
                   │ metadata     │                 │ (disk, LRU)       │
                   └──────────────┘                 └─────────┬─────────┘
                                                              │ miss
                                                    ┌─────────▼─────────┐
                                                    │ Telegram Bot API  │
                                                    │ private channel   │
                                                    └───────────────────┘
```

The visitor's browser only ever talks to the first box. Telegram is reached
server-side and its existence is not observable from any response.

---

## Why Telegram is invisible, structurally

"Do not leak the storage backend" is easy to say and easy to break with one
careless field. Three mechanisms make it hard to break by accident:

1. **The wire types have no place to put it.** `src/lib/serializers.ts` defines
   `PublicAudio` and `AdminAudio`. Neither declares `telegramFileId`,
   `telegramChatId` or anything similar, so a route that tried to return a raw
   database row would fail typecheck rather than leak.

2. **The bytes are proxied, never redirected.** `src/lib/media/serve.ts`
   returns a stream with our own headers. There is no code path that emits a
   `Location`, and a test asserts the download response carries no `Location`
   and no header mentioning Telegram.

3. **The Content-Security-Policy forbids it.** `media-src 'self' blob:` means
   that even if a future change did hand the browser a Telegram URL, the
   browser would refuse to load it.

Tests cover all three, including one that serialises a fully-populated row and
asserts that no Telegram identifier appears anywhere in the JSON.

---

## Storage: what the Bot API can and cannot do

Verified against the Bot API documentation, September 2026.

| | Cloud API | Local Bot API server |
| --- | --- | --- |
| Bot uploads | 50 MB | 2000 MB |
| Bot downloads (`getFile`) | **20 MB** | no limit |
| `getFile` path lifetime | ≥ 1 hour | absolute local path |

**The download limit binds, not the upload limit.** Every stored file has to be
served back to a visitor. Accepting a 40 MB upload on the cloud API would
produce a track that is permanently unplayable, so `getConfig()` clamps
`MAX_AUDIO_UPLOAD_BYTES` to what the configured mode can actually return and
records a warning that the Storage screen displays.

This is the constraint that decided the ceiling. Everything else about the
storage design follows from working comfortably inside it.

### Upload path

```
request body (stream)
   → busboy, parsed as it arrives
   → written straight to a temp file, byte count enforced during the write
   → first 512 bytes kept for content sniffing
   → validated: signature, format, size, declared-type agreement
   → UploadIntent row written           ← durability point begins
   → openAsBlob(temp) → FormData → fetch → Telegram
   → intent updated with Telegram ids   ← durability point ends
   → MediaFile + Audio rows created
   → intent marked committed, temp file deleted
```

Two things are deliberate:

- **Nothing is buffered.** `request.formData()` would materialise the whole
  upload as a `Blob` in memory before the handler saw a byte — fine for a 2 MB
  ringtone, fatal for a 2 GB file on a local server, and it charges memory
  before the size can even be checked. Instead busboy streams to disk and
  `fs.openAsBlob` streams back out. Measured: a 64 MB upload grows the heap by
  under 1 MB.
- **The size limit is enforced mid-flight.** busboy raises as soon as the
  configured byte count is exceeded, so an oversized upload stops costing
  bandwidth immediately rather than being rejected after it has all arrived.

### The failure that the `UploadIntent` table exists for

Storing a file spans two systems. Telegram accepts the bytes; then the database
records where they went. A crash between those two steps, in the naive design,
loses a file permanently: the bytes sit in a private channel with nothing on
this side that knows what they are.

So a durable row is written **before** the bytes leave, and updated with
Telegram's identifiers **the instant** they come back:

| status | meaning |
| --- | --- |
| `received` | validated and spooled; nothing sent |
| `uploading` | handed to Telegram; outcome unknown |
| `uploaded` | Telegram returned identifiers — they are now durable |
| `committed` | the track exists; the intent is history |
| `failed` | Telegram refused; nothing was stored, nothing leaked |

Anything stuck at `uploading` or `uploaded` appears on **Admin → Storage** with
two actions: **Recover**, which builds the media row from the identifiers
already on record without re-uploading, and **Discard**, which deletes the
Telegram message and the row. A message Telegram refuses to delete leaves the
row marked `abandoned` rather than vanishing, so it stays auditable.

Integration tests exercise all of it, including a message Telegram will not
delete.

### Retrieval and caching

Telegram is the durable store. A bounded on-disk cache sits in front of it, for
three reasons:

1. **Range requests.** An `<audio>` element seeks by issuing `Range` requests.
   Serving those from a local file is exact and cheap. Proxying each one would
   mean a `getFile` round trip plus a fresh HTTPS transfer per seek, and
   Telegram's CDN is not contractually required to honour `Range` at all.
2. **Rate limits.** A track that gets shared once may be fetched hundreds of
   times an hour. Cached, that is one Telegram transfer.
3. **Latency.** Local disk beats a round trip.

Serving order:

1. **Cached** → stream the exact byte range off disk.
2. **Not cached, small enough** → fill once, then serve from disk. The fill is
   single-flighted, so a hundred simultaneous first plays produce exactly one
   Telegram download. A test asserts this with eight concurrent requests.
3. **Too large to cache, or the fill failed** → proxy through from Telegram,
   applying the range ourselves if the CDN chose not to.

The cache is **not** a second copy of the library. It is bounded by
`MEDIA_CACHE_MAX_BYTES` (2 GiB by default) and evicts least-recently-used
entries. Deleting the whole directory is always safe. Unlinking a file that a
response is still reading is fine on POSIX — the open descriptor keeps the inode
alive until that read finishes.

Resolved `getFile` paths are cached in the database for 45 minutes against
Telegram's "at least one hour" guarantee, so a busy track costs one `getFile`
per 45 minutes rather than one per request. An expired path produces a 404 from
Telegram, which `openMedia` catches, re-resolves, and retries once — invisibly.

---

## Streaming and downloads

`src/lib/media/serve.ts` is the only place that turns a stored file into a
response. It handles:

- **`Range`** — closed, open-ended and suffix forms, `206` with `Content-Range`,
  `416` with `bytes */size` for an unsatisfiable one. Multi-range requests are
  answered with the whole resource, which the spec permits and which avoids a
  `multipart/byteranges` body for a case no audio element sends.
- **`Accept-Ranges: bytes`** on every response. Safari refuses to play at all
  without it.
- **`ETag`** derived from the immutable file identity and size, with `304` on
  revalidation.
- **`HEAD`** answered with full headers and no body, without touching Telegram.
- **`Content-Disposition`** — `inline` for playback, `attachment` for download,
  with both an ASCII `filename` and an RFC 5987 `filename*` so a Tamil title
  survives. Quotes and backslashes are stripped rather than escaped, so no title
  can break out of the quoted string.

The download filename comes from the track's slug and its stored mime type:
`tamil-og-ringtone.mp3`.

`parseRange` is a pure function with 21 unit tests, because seeking silently
breaking is the kind of bug nobody reports.

---

## Data model

SQLite, via Prisma. See `prisma/schema.prisma` for the annotated definition.

```
AdminUser ──< Session

Category ──< Audio >── MediaFile        (the audio file)
                  \──── MediaFile        (optional cover)
                  \──< TagOnAudio >── Tag
                  \──< DownloadEvent

UploadIntent    (crash-safe upload bookkeeping)
CachedFile      (the media cache's LRU index)
SiteSetting     (owner-editable copy)
```

Indexes exist for every access path the application actually uses: category
listings ordered by `sortOrder`, recent and popular listings filtered by
`isPublished`, event aggregation by day, and cache eviction by
`lastAccessedAt`.

### Why SQLite

- The workload is one owner writing occasionally and visitors reading. WAL mode
  gives concurrent readers alongside a single writer, which is more concurrency
  than this will ever need.
- A persistent volume is already required for the media cache, so the database
  costs no additional infrastructure.
- No connection pool to size, no separate service to run, back up, patch or pay
  for. Backing up means copying one file.
- Real transactions and real migrations — the properties that actually matter.

**Moving to PostgreSQL** is a provider change in `prisma/schema.prisma`, a
regenerated migration, and a different `DATABASE_URL`. No application code
depends on SQLite specifics; `src/lib/repositories/search.ts` is the only module
that would want revisiting, and it says so in its own comment.

### Search

Every query term must appear in a denormalised lowercase haystack per track
(title + artist + category name + tags), then results are ranked by where the
match landed: an exact title beats a title prefix, beats a word-start match,
beats an artist match, beats a tag or category match.

`LIKE '%term%'` cannot use an index, so this is a scan. At the size this library
will ever reach that is microseconds, and it wins on behaviour: it matches
inside words, which is what someone typing "vij" expects, and it handles Tamil
text without a tokeniser that understands Tamil.

**When to change it.** Past roughly 50,000 tracks the scan will start to show.
The path is SQLite FTS5 — a virtual table over the same haystack, kept in sync
with triggers, and `MATCH` in place of the `LIKE`s. Nothing outside
`search.ts` would change, because every caller goes through `searchAudio`.

The haystack is rebuilt on every write that touches a searchable field,
including renaming a category (which rewrites its members). Tests cover each
case.

---

## Authentication

One owner. No registration, no password reset, no email.

- **Credentials come from the environment.** `ADMIN_USERNAME` and
  `ADMIN_PASSWORD_HASH`. Rotating the password in the environment takes effect
  on next start and revokes every existing session.
- **scrypt** for hashing — `N=2^15, r=8, p=1`, OWASP's recommended parameters.
  It is in Node's standard library, so no native addon complicates the build.
  For one account the difference from argon2 is not worth a compiled dependency.
- **The encoded hash uses `:` separators, not `$`.** This value lives in an
  environment variable, and `.env` loaders perform `$VAR` expansion on values —
  a `$`-separated hash silently loses its parameters on load and locks the owner
  out with a baffling error. Base64 never contains a colon. There is a
  regression test.
- **Sessions are server-side rows.** The cookie carries an opaque 32-byte
  random token; only its SHA-256 hash is stored, so database read access does
  not yield a usable session. Sign-out is a row delete, which is what makes it
  real rather than cosmetic.
- **Cookies** are `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- **CSRF** uses double-submit — a token derived by HMAC from a per-session
  secret, echoed from a readable cookie into a request header — plus an origin
  check. Two independent mechanisms, because each has gaps the other covers.

The origin check derives the expected origin from the request itself
(`X-Forwarded-Proto` + `Host`), not from `NEXT_PUBLIC_SITE_URL` alone. Deriving
it from configuration rejects every admin write behind a TLS-terminating proxy,
and on any hostname other than the configured one. That was a real bug, found by
the end-to-end test, and it has regression cover.

---

## The player

One `<audio>` element for the whole application, created lazily and owned by a
module-level store. That is what makes "only one track plays at a time"
structurally true rather than a rule the UI has to remember.

State is split across two stores with independent subscriber sets:

- **`playback`** — which track, playing, loading, errored. Changes rarely.
- **`progress`** — current time, duration, buffered. Changes ~4×/second.

Track rows subscribe only to `playback`, through a hook whose snapshot is a
plain boolean ("am I the current track?"). Starting playback therefore re-renders
exactly two rows — the one stopping and the one starting — regardless of how
long the list is. Only the mini-player subscribes to `progress`.

Both are read with `useSyncExternalStore`, which is correct under concurrent
rendering and needs no context provider.

The element lives in the root layout, so a track keeps playing across
navigation. `MediaSession` metadata is published, so lock-screen and headphone
controls work on a phone. Nothing autoplays: every path into playback starts
with a click or a key press.

---

## Front-end choices

**No CSS framework, no animation library, no state library, no icon package.**
The whole visual system is one stylesheet of custom properties
(`src/app/globals.css`); icons are twelve inline SVGs, smaller than any icon
package's entry point; animation is CSS transitions on `transform` and
`opacity` only, so everything that moves is composited and nothing triggers
layout mid-interaction.

**System fonts.** No webfont request, no FOUT, no layout shift, nothing to
self-host — the single largest first-visit performance win available. Character
comes from scale, weight and tracking instead.

**Server components by default.** The song page ships no JavaScript except the
play/download control. Category cards are plain links. The client bundle exists
for the player, search suggestions, and the admin.

**`prefers-reduced-motion`** collapses transitions to near-instant rather than
to zero — state changes still read as changes — and stops decorative loops
entirely.

---

## Dependencies, and why each one is there

| | |
| --- | --- |
| `next`, `react`, `react-dom` | the framework |
| `@prisma/client`, `prisma`, `@prisma/adapter-better-sqlite3` | typed database access and migrations |
| `zod` | input validation at every boundary, with `.strict()` refusing unknown keys so mass assignment fails loudly |
| `busboy` | streaming multipart parsing — the alternative buffers whole uploads into memory |
| `server-only` | turns "this module must not reach the browser" into a build error |

That is the entire runtime dependency list. Anything else — icons, styling,
animation, state management, date formatting, HTTP clients — is either in the
platform or is a few lines in `src/lib`.

---

## Testing

**224 unit and integration tests, plus 60 end-to-end checks.**

- **Unit** — content sniffing against real file signatures, range parsing,
  password hashing and its failure modes, rate limiting, slug generation,
  serialisation (including an assertion that no Telegram field can escape).
- **Integration** — the real route handlers, called as Next calls them, against
  a real SQLite database and a stand-in Bot API that speaks the same wire
  protocol. Covers the upload pipeline, reconciliation, streaming, seeking,
  downloads, search, and every authorisation path. The fake can be told to fail
  in specific ways — `429` with `retry_after`, "file is too big", a permissions
  error, a network drop — which is how the error paths get covered at all.
- **End-to-end** — builds the app, starts a real production server against a
  stand-in Bot API, and drives it over HTTP. This exists because a whole class
  of defect is invisible to handler tests: they cannot see status codes the
  framework decides. It found two real bugs, both now asserted:
  - a root `loading.tsx` opened a Suspense boundary that streamed `200 OK`
    before `notFound()` or `redirect()` could run, turning every 404 into a soft
    404 and the admin guard's redirect into a client-side one;
  - the origin check described above.

`npm run verify` runs lint, typecheck, tests, the production build and the
end-to-end suite.
