import 'server-only';

import { prisma } from '../db';

/**
 * Analytics.
 *
 * Only counts. No IP addresses, no user agents, no cookies, no identifiers, no
 * third-party script — a `DownloadEvent` row says "a download of track X
 * happened at time T" and nothing else, which is all the dashboard needs and
 * nothing a visitor should have to consent to.
 */

export interface DashboardStats {
  readonly totalTracks: number;
  readonly publishedTracks: number;
  readonly totalCategories: number;
  readonly totalDownloads: number;
  readonly downloadsLast7Days: number;
  readonly downloadsLast30Days: number;
  readonly storedBytes: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const [
    totalTracks,
    publishedTracks,
    totalCategories,
    downloadAggregate,
    downloadsLast7Days,
    downloadsLast30Days,
    sizeAggregate,
  ] = await Promise.all([
    prisma.audio.count(),
    prisma.audio.count({ where: { isPublished: true } }),
    prisma.category.count(),
    prisma.audio.aggregate({ _sum: { downloadCount: true } }),
    prisma.downloadEvent.count({ where: { kind: 'download', createdAt: { gte: sevenDaysAgo } } }),
    prisma.downloadEvent.count({ where: { kind: 'download', createdAt: { gte: thirtyDaysAgo } } }),
    prisma.mediaFile.aggregate({ _sum: { fileSize: true }, where: { kind: 'audio' } }),
  ]);

  return {
    totalTracks,
    publishedTracks,
    totalCategories,
    totalDownloads: downloadAggregate._sum.downloadCount ?? 0,
    downloadsLast7Days,
    downloadsLast30Days,
    storedBytes: sizeAggregate._sum.fileSize ?? 0,
  };
}

export interface PopularTrack {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly artist: string | null;
  readonly downloadCount: number;
  readonly playCount: number;
  readonly categoryName: string | null;
}

export async function getPopularTracks(limit = 10): Promise<PopularTrack[]> {
  const rows = await prisma.audio.findMany({
    where: { downloadCount: { gt: 0 } },
    orderBy: [{ downloadCount: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    select: {
      id: true,
      title: true,
      slug: true,
      artist: true,
      downloadCount: true,
      playCount: true,
      category: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    artist: row.artist,
    downloadCount: row.downloadCount,
    playCount: row.playCount,
    categoryName: row.category?.name ?? null,
  }));
}

export interface RecentUpload {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly createdAt: Date;
  readonly isPublished: boolean;
  readonly categoryName: string | null;
}

export async function getRecentUploads(limit = 8): Promise<RecentUpload[]> {
  const rows = await prisma.audio.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      title: true,
      slug: true,
      createdAt: true,
      isPublished: true,
      category: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    createdAt: row.createdAt,
    isPublished: row.isPublished,
    categoryName: row.category?.name ?? null,
  }));
}

export interface DailyCount {
  readonly day: string;
  readonly downloads: number;
}

/**
 * Downloads per day for the last `days` days, with zero-filled gaps so the
 * chart does not silently compress quiet periods.
 */
export async function getDailyDownloads(days = 30): Promise<DailyCount[]> {
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  since.setUTCHours(0, 0, 0, 0);

  const grouped = await prisma.downloadEvent.groupBy({
    by: ['day'],
    where: { kind: 'download', createdAt: { gte: since } },
    _count: { _all: true },
  });

  const counts = new Map(grouped.map((row) => [row.day, row._count._all]));
  const out: DailyCount[] = [];

  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(since.getTime() + offset * 24 * 60 * 60 * 1000);
    const day = date.toISOString().slice(0, 10);
    out.push({ day, downloads: counts.get(day) ?? 0 });
  }

  return out;
}

/**
 * Drop event rows older than `days`. The aggregate counters on each track are
 * permanent; only the per-event detail expires, which keeps the table bounded
 * on a site that runs for years.
 */
export async function pruneOldEvents(days = 400): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { count } = await prisma.downloadEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
