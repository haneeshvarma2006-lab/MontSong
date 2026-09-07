import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moves the connection URL out of schema.prisma. The CLI (migrate,
 * studio) reads it from here; the application creates its own adapter in
 * src/lib/db.ts so both paths resolve the same file.
 *
 * DATABASE_URL uses the `file:` form, e.g. `file:./data/montsong.db`.
 * Relative paths are resolved from the project root (not from prisma/).
 */
const url = process.env.DATABASE_URL ?? 'file:./data/montsong.db';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url,
  },
});
