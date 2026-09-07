#!/bin/sh
# Apply any pending migrations, then hand over to the server.
#
# `migrate deploy` only ever applies migrations that already exist in
# prisma/migrations — it never generates one and never resets a database, so it
# is safe to run unattended on every container start.
set -e

echo "Applying database migrations…"
npx prisma migrate deploy

echo "Starting MontSong…"
exec "$@"
