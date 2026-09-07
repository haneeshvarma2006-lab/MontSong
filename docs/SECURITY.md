# Security

What this application defends against, how, and what it deliberately does not
try to defend against. Written after a review of the finished code, with the
checks that were actually run.

---

## What is being protected

Three things, in descending order of consequence:

1. **The Telegram bot token.** Whoever holds it can read, post to and delete
   from the storage channel. It is the crown jewel, and it is also the thing
   most likely to leak through carelessness, because it appears in every API
   URL the server builds.
2. **Write access to the library.** Only the owner may upload, edit, delete or
   reorder anything.
3. **The visitors' privacy.** No accounts, no cookies for anonymous visitors,
   no third-party scripts, no personal data collected at all.

Public *read* access is not a thing to protect: the library is meant to be
found, played and downloaded by anyone.

---

## Keeping the storage backend invisible

This is the requirement with the most ways to break it accidentally, so it is
defended structurally rather than by discipline.

**The wire types have no field for it.** `src/lib/serializers.ts` defines
`PublicAudio` and `AdminAudio`. Neither declares `telegramFileId`,
`telegramChatId`, `telegramMessageId` or `telegramFilePath`. A route that tried
to return a raw database row would fail typecheck, not leak.

**Bytes are proxied, never redirected.** `serveMedia` builds a `Response` around
a stream with our own headers. No code path emits a `Location`.

**The Content-Security-Policy forbids it.** `media-src 'self' blob:` means that
even if a future change did hand the browser a Telegram URL, the browser would
refuse to load it.

**The logger redacts.** Every string passing through it has anything shaped
like a bot token stripped, and keys matching `token|secret|password|cookie|
authorization` are replaced with `<redacted>`.

Verified, on the built application:

| check | result |
| --- | --- |
| Bot token in `.next/static` | 0 files |
| `AUTH_SECRET` in `.next/static` | 0 files |
| Password hash in `.next/static` | 0 files |
| Storage chat id in `.next/static` | 0 files |
| `api.telegram.org` in `.next/static` | 0 files |
| Bot token, chat id or "telegram" in the homepage HTML | 0 occurrences |
| Client components importing a server module | none |
| `process.env` referenced in a client component | none |

Automated cover: a unit test serialises a fully-populated row and asserts that
no Telegram identifier appears anywhere in the JSON, for both the public and
admin shapes; integration tests assert the same of download response headers;
and the end-to-end suite asserts it of the rendered HTML of every public page.

---

## Authentication and authorisation

**Server-side, on every route.** Every `/api/admin/*` handler calls
`requireAdmin` before touching anything. Hiding the admin UI is not a control
and is not relied on: a `curl` request is rejected identically to a browser one.
The end-to-end suite asserts a `401` on every admin endpoint anonymously.

**Defence in depth on the pages.** `src/middleware.ts` redirects a request with
no session cookie away from `/admin` before Next renders anything, so admin
markup is never generated for an anonymous visitor. The `(dashboard)` layout
then does the authoritative check — the middleware runs at the edge and has no
database, so it can only see that a cookie is *absent*, never that one is valid.

**Passwords.** scrypt at OWASP's recommended parameters (N=2¹⁵, r=8, p=1). The
plaintext is never stored, never logged, and never leaves the request. A
malformed or corrupt stored hash fails closed — it returns false rather than
throwing, so a misconfiguration rejects the login instead of 500-ing.

**Sessions.** The cookie carries an opaque 32-byte random token; only
`HMAC(AUTH_SECRET, token)` is stored, so read access to the database does not
yield a usable session. Sign-out deletes the row, so a captured cookie dies
with it — there is a test that replays a captured cookie after sign-out and
asserts it fails. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in
production. Expired sessions are deleted on sight.

**Three things revoke a session, and all three are real.** Deleting the row.
Rotating `AUTH_SECRET`, which changes the key every stored hash was computed
under, so no presented token can match anything. Rotating
`ADMIN_PASSWORD_HASH`, which `getSessionFromToken` notices on the very next
request by comparing the session's user against the configured hash — it does
not wait for someone to attempt a login.

Both rotations were inoperative until the review described below; the
regression tests now hold a captured token and assert it stops working.

### Brute force

Three independent brakes:

| | |
| --- | --- |
| Per-address token bucket | 5 attempts, one back every 30 seconds |
| Per-account lockout | escalating: 2 min at 5 failures, 15 min at 10, 60 min at 20 |
| Constant response cost | a wrong username still runs a full password verification |

The third matters as much as the others: without it, a wrong username returns
measurably faster than a wrong password, which tells an attacker whether an
account exists. Every failure returns the same status and the same words —
there is a test asserting the two messages are byte-identical.

### CSRF

Two mechanisms, because each has gaps the other covers:

- **Double-submit token.** Derived by HMAC from a per-session secret using
  `AUTH_SECRET`, delivered in a script-readable cookie, and echoed back in a
  request header. Same-origin JavaScript can read the cookie; cross-origin
  JavaScript cannot. Compared in constant time.
- **Origin check.** `Origin`, falling back to `Referer`, must match an allowed
  origin. A state-changing request with neither is refused.

The allowed origin is derived from the request itself — `X-Forwarded-Proto` plus
`Host` — not from `NEXT_PUBLIC_SITE_URL` alone. **This was a real bug**: deriving
it from configuration rejected every admin write behind a TLS-terminating proxy,
because the application sees plain HTTP while the browser sends
`Origin: https://…`. Found by the end-to-end suite; it now has regression tests.

---

## Uploads

The dangerous input in this application is a file, so it is treated as hostile
from the first byte.

**Content is identified from its own bytes.** `sniff()` reads the leading
signature. The declared `Content-Type` and the filename extension are both
attacker-controlled and neither is trusted; the declared type only has to
*agree* with what was found, and a contradiction is a rejection rather than a
guess. A shell script named `payload.mp3` and declared `audio/mpeg` is refused.

**Only playable audio formats are accepted** — MP3, M4A, AAC, OGG, Opus, WAV,
FLAC — and only JPEG, PNG and WebP for artwork. An MP4 with a video brand is
rejected even though it is legitimate media.

**Size is enforced during the write, not after it.** busboy raises the moment
the byte count is exceeded, so an oversized upload stops costing bandwidth
immediately. A `Content-Length` over the limit is refused before a byte is read.

**Filenames are sanitised.** Every path separator and control character is
stripped, `.` and `..` are refused, and the length is capped. `../../etc/passwd`
becomes `passwd`. There are unit tests for traversal, control characters (which
could otherwise forge a response header) and non-ASCII names.

**Temporary files are always cleaned up**, in a `finally`, on every path
including rejection. A test asserts the spool directory is empty afterwards.

**Serving cannot be turned into an XSS.** The stored mime type can only be one
of the accepted audio or image types, so `text/html` is unreachable. Responses
also carry `X-Content-Type-Options: nosniff`, and cache paths are built from a
hard-restricted alphabet so a filename can never escape the cache directory.

---

## Injection

**SQL.** Everything goes through Prisma, which parameterises. The only raw SQL
in the application is four constant `PRAGMA` statements with no interpolation.
A test searches for `'; DROP TABLE audio; --` and asserts it returns no results
and that the table still has its rows.

**XSS.** React escapes by default. There is exactly one
`dangerouslySetInnerHTML` in the codebase — the JSON-LD block on the song page —
and it serialises our own database rows with `<` escaped to `<`, so no
title can close the script element early.

**Header injection.** `Content-Disposition` strips quotes and backslashes rather
than escaping them, so no filename can break out of the quoted string, and
non-ASCII goes through the RFC 5987 `filename*` form. Control characters are
removed at upload time as well.

**CSS injection.** A category's accent colour is written into a custom property
and is validated as a hex colour by zod on write. It is also only reachable by
an authenticated owner.

**Mass assignment.** Every zod schema is `.strict()`, so an unknown key is a
`422` rather than being silently ignored. Sending `downloadCount: 99999` to the
track update endpoint fails, and there is a test asserting the stored count is
unchanged.

---

## Response headers

Set for every response:

| header | value |
| --- | --- |
| `Content-Security-Policy` | per-request nonce, `'strict-dynamic'`, no `'unsafe-inline'` for scripts |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` (with `frame-ancestors 'none'`) |
| `Permissions-Policy` | camera, microphone, geolocation, payment all denied |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Strict-Transport-Security` | two years, `includeSubDomains`, `preload` |
| `X-Powered-By` | removed |

The CSP is generated per request in middleware so it can carry a nonce. A static
CSP for a React app has to allow `script-src 'unsafe-inline'`, which weakens it
to the point of not stopping an injected `<script>`. Verified on the running
application: every `<script>` tag in the rendered HTML carries the nonce, and
zero do not.

**CORS** is not configured, which is the correct configuration: no
`Access-Control-Allow-Origin` header means the browser blocks cross-origin
reads of the API by default.

---

## Privacy

- No accounts, no sign-up, no cookies for anonymous visitors.
- No third-party scripts, no fonts loaded from a CDN, no analytics service, no
  tracking pixels. The CSP's `default-src 'self'` makes that structural.
- A `DownloadEvent` row records the track, the kind of event and the time. It
  has no column for an IP address, a user agent, a session or any identifier.
- IP addresses are used transiently for rate limiting and are HMAC'd with
  `AUTH_SECRET` before being used as a bucket key. The only place a hash is
  persisted is on the owner's own session row.
- `robots.txt` keeps crawlers out of `/admin` and `/api`.

---

## What is deliberately not defended against

Stated plainly, because a security document that claims to cover everything is
not useful.

- **A compromised server.** Anyone with the environment variables has the bot
  token and the library. Protect the host.
- **A compromised owner device or password.** There is no second factor. For a
  single-owner personal site this is a proportionate choice; a long unique
  password and a locked device are the control.
- **Denial of service.** Rate limiting protects the application and Telegram's
  quota, not the network. Real DoS protection belongs at the CDN or proxy.
- **Multi-instance rate limiting.** Limits are per-process. The documented
  deployment is a single process; running several would weaken them
  proportionally. `src/lib/auth/rate-limit.ts` is the one module to change.
- **Telegram itself.** Files are stored in a private channel under Telegram's
  security model and are not end-to-end encrypted. Do not put anything in this
  library you would not put in a private Telegram channel.
- **The owner's own uploads.** An authenticated owner can upload anything the
  validator accepts. The validator constrains format, not content.

---

## What the reviews found

### Round one — the end-to-end suite

Both of these were invisible to tests that call route handlers as functions,
which is why the end-to-end suite exists. Both have regression cover.

1. **Soft 404s and a client-side admin redirect.** A root `loading.tsx` opened a
   Suspense boundary that streamed `200 OK` before `notFound()` or `redirect()`
   could run. Every missing page returned `200` (bad for SEO), and, more
   seriously, the admin guard's redirect became a client-side one — so the
   framework had already begun a `200` response for `/admin` to an anonymous
   visitor. Fixed by removing the root loading boundary and adding middleware.
   Asserted now: `/admin` answers `307`, missing pages answer `404`.

2. **Admin writes rejected behind a proxy.** Described under CSRF above.

A third, found by an integration test: `adoptOrphan` did not close out the
upload intent, so a recovered file would reappear as an orphan forever and
adopting it twice would create a duplicate media row.

### Round two — pre-release review

4. **Both "sign out everywhere" levers were inoperative.** The more serious of
   the two findings, because the failure mode is a false sense of safety: an
   owner who believes they have ejected a stolen session had not.

   `hashToken` was an *unkeyed* SHA-256, so `AUTH_SECRET` played no part in
   session lookup and rotating it left every session row matchable. Separately,
   the `deleteMany` that clears sessions on a password change lived inside
   `ensureAdminUser`, which is called from exactly one place — the login
   handler. Changing `ADMIN_PASSWORD_HASH` and restarting therefore revoked
   nothing until somebody attempted a login, which an attacker holding a live
   cookie has no reason to do.

   The stored hash is now `HMAC(AUTH_SECRET, token)`, so rotation invalidates
   every row by construction; and `getSessionFromToken` rejects any session
   whose user still carries a different password hash, so a password rotation
   takes effect on the attacker's next request. `tests/integration/session-revocation.test.ts`
   covers both from the attacker's side — it holds a captured token and checks
   it stops working — and each half was confirmed to fail against the code as
   it stood before the fix.

5. **A published admin password in preview mode.** `npm run preview` signed in
   with a constant committed to this repository, and `next start` binds every
   interface. Anyone on the same network as a running preview could open it,
   sign in as the owner, and upload files. The password is now generated per
   run, and the preview binds `127.0.0.1`.

6. **A storage identifier in a public ETag.** `serveMedia` emitted
   `"<telegram_file_unique_id>-<size>"`. Not exploitable — that identifier
   cannot fetch anything without the bot token — but it contradicted this
   document and the module's own comment, and an existing test had been written
   around the omission. The ETag is now a digest, which keeps the validator
   stable and immutable while telling a client nothing.

7. **A malformed cookie returned 500.** `Cookie: montsong_session=%` reached an
   unguarded `decodeURIComponent`. A junk cookie is simply not a session; it now
   answers `401`.

### Assessed and not acted on

- **`mysql2` advisories (4 high) reported by `npm audit`.** It reaches this
  project only as a transitive dependency of the Prisma CLI. The schema is
  SQLite, the runtime adapter is `better-sqlite3`, no hand-written code
  references MySQL, and `mysql2` is not present in the built server bundle.
  Both advisories require an actual connection to a MySQL server, which never
  occurs. The offered remedy downgrades Prisma 7 to 6 — a breaking change for
  no security benefit. Re-assess if a MySQL datasource is ever added.

- **`/api/admin/auth/logout` has no CSRF token check.** A cross-site POST can
  sign the owner out. Deliberate: the cost is a nuisance, and requiring a token
  to log out means a stale token can trap someone in a session they want to end.

- **Rate-limit keys derive from `X-Forwarded-For`,** which is client-controlled
  when no proxy normalises it. The per-account lockout, which does not depend on
  the address, is what actually bounds password guessing.

---

## Running the checks

```bash
npm run verify        # lint, typecheck, tests, production build, end-to-end
```

The security-relevant assertions live in:

- `tests/unit/serializers.test.ts` — nothing Telegram-shaped escapes serialisation
- `tests/unit/auth.test.ts` — hashing, failure modes, rate limiting, origin checks
- `tests/unit/sniff.test.ts` — content detection, spoofing, filename sanitising
- `tests/integration/auth.test.ts` — every admin route anonymously, CSRF, lockout
- `tests/integration/upload.test.ts` — upload validation and rejection paths
- `tests/integration/media.test.ts` — no storage detail in any response header
- `tests/integration/session-revocation.test.ts` — rotating either secret really does revoke
- `tests/e2e/run.mjs` — the whole surface over real HTTP

---

## Reporting something

This is a personal project with one owner. If you find a problem, contact the
site's owner directly rather than filing it in public.
