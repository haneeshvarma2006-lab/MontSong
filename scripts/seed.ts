/**
 * Seed a starter set of categories.
 *
 *   npm run db:seed
 *
 * Deliberately limited to categories, and deliberately idempotent: it will not
 * touch a category that already exists, and it creates no tracks, because a
 * track without a real file in storage would be a broken row.
 *
 * The names below are only a starting point. Every one of them can be renamed,
 * reordered or deleted from the admin, and nothing in the codebase depends on
 * any of them existing — that is the point of the category system.
 */
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

// The generated client is JavaScript; `--experimental-strip-types` will not
// rewrite this specifier, so point at the emitted file directly.
import { PrismaClient } from '../src/generated/prisma/client.js';

interface SeedCategory {
  name: string;
  slug: string;
  description: string;
  icon: string;
  accent: string;
  isFeatured?: boolean;
}

const CATEGORIES: SeedCategory[] = [
  {
    name: 'Tamil OGs',
    slug: 'tamil-ogs',
    description: 'The originals — the ones everyone already knows the first note of.',
    icon: '🎬',
    accent: '#ff8a3d',
    isFeatured: true,
  },
  {
    name: 'Ringtones',
    slug: 'ringtones',
    description: 'Short, loud, and made to be heard across a room.',
    icon: '📱',
    accent: '#5ddba0',
    isFeatured: true,
  },
  {
    name: 'BGM',
    slug: 'bgm',
    description: 'Background scores and themes, without the vocals.',
    icon: '🎻',
    accent: '#7aa2ff',
  },
  {
    name: 'Mass Songs',
    slug: 'mass-songs',
    description: 'For the intro shots and the whistle-worthy drops.',
    icon: '🔥',
    accent: '#ff6b6b',
  },
  {
    name: 'Love Songs',
    slug: 'love-songs',
    description: 'Slow, warm, and unhurried.',
    icon: '💛',
    accent: '#ffd166',
  },
  {
    name: 'Sad Songs',
    slug: 'sad-songs',
    description: 'For the drive home.',
    icon: '🌧️',
    accent: '#9aa0ff',
  },
];

/** Same id scheme as the application — sortable, URL-safe, 24 characters. */
function createId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const time = Date.now().toString(36).padStart(8, '0');
  let suffix = '';
  for (let index = 0; index < 16; index += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${time}${suffix}`;
}

function resolveDatabaseFile(url: string): string {
  const withoutScheme = url.startsWith('file:') ? url.slice('file:'.length) : url;
  return path.isAbsolute(withoutScheme) ? withoutScheme : path.resolve(process.cwd(), withoutScheme);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'file:./data/montsong.db';
  const file = resolveDatabaseFile(url);

  if (!fs.existsSync(file)) {
    console.error(
      `No database at ${file}. Run \`npm run db:deploy\` (or \`npm run db:migrate\`) first.`,
    );
    process.exit(1);
  }

  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: file }) });

  try {
    const existing = await prisma.category.count();
    let created = 0;
    let skipped = 0;

    for (const [index, category] of CATEGORIES.entries()) {
      const found = await prisma.category.findUnique({ where: { slug: category.slug } });
      if (found) {
        skipped += 1;
        continue;
      }

      await prisma.category.create({
        data: {
          id: createId(),
          name: category.name,
          slug: category.slug,
          description: category.description,
          icon: category.icon,
          accent: category.accent,
          isFeatured: category.isFeatured ?? false,
          sortOrder: existing + index + 1,
        },
      });
      created += 1;
    }

    console.log(
      `Seeded ${created} categor${created === 1 ? 'y' : 'ies'}` +
        (skipped > 0 ? `, left ${skipped} that already existed alone.` : '.'),
    );
    console.log('Rename, reorder or delete any of them from /admin/categories.');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Seeding failed:', error);
  process.exit(1);
});
