import 'server-only';

import { prisma } from './db';

/**
 * Owner-editable site copy, with sensible defaults so a fresh install reads
 * like a finished site rather than a template full of placeholders.
 */

export interface SiteCopy {
  readonly name: string;
  readonly tagline: string;
  readonly about: string;
}

const DEFAULTS = {
  tagline: 'A hand-picked library of songs, ringtones and BGM. Play it, take it, keep it.',
  about: 'Every track here is free to play and free to download.',
} as const;

export async function getSiteCopy(): Promise<SiteCopy> {
  const name = process.env.NEXT_PUBLIC_SITE_NAME ?? 'MontSong';

  const rows = await prisma.siteSetting
    .findMany({ where: { key: { in: ['tagline', 'about'] } } })
    .catch(() => []);

  const map = new Map(rows.map((row) => [row.key, row.value]));

  return {
    name,
    tagline: map.get('tagline') || DEFAULTS.tagline,
    about: map.get('about') || DEFAULTS.about,
  };
}

export async function setSiteCopy(values: { tagline?: string; about?: string }): Promise<void> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined) as [
    string,
    string,
  ][];

  await prisma.$transaction(
    entries.map(([key, value]) =>
      prisma.siteSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      }),
    ),
  );
}

/** Absolute site origin, used for canonical URLs and Open Graph tags. */
export function siteUrl(path = ''): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
