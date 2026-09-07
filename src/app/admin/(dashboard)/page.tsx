import Link from 'next/link';

import { formatBytes, formatCount, formatDate } from '@/lib/format';
import {
  getDailyDownloads,
  getDashboardStats,
  getPopularTracks,
  getRecentUploads,
} from '@/lib/repositories/analytics';

/**
 * Overview.
 *
 * Rendered entirely on the server — it is four aggregate queries and no
 * interaction, so shipping a client component for it would buy nothing.
 */
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Overview' };

export default async function AdminDashboard() {
  const [stats, popular, recent, daily] = await Promise.all([
    getDashboardStats(),
    getPopularTracks(8),
    getRecentUploads(6),
    getDailyDownloads(30),
  ]);

  const peak = Math.max(1, ...daily.map((day) => day.downloads));

  return (
    <div className="stack-lg">
      <div className="admin__toolbar">
        <div>
          <h1 className="admin__title">Overview</h1>
          <p className="admin__subtitle">Everything at a glance.</p>
        </div>
        <Link href="/admin/songs/new" className="btn btn--primary">
          Add a song
        </Link>
      </div>

      <div className="stats">
        <div className="stat">
          <p className="stat__value">{formatCount(stats.totalTracks)}</p>
          <p className="stat__label">
            Tracks · {formatCount(stats.publishedTracks)} published
          </p>
        </div>
        <div className="stat">
          <p className="stat__value">{formatCount(stats.totalCategories)}</p>
          <p className="stat__label">Categories</p>
        </div>
        <div className="stat">
          <p className="stat__value">{formatCount(stats.totalDownloads)}</p>
          <p className="stat__label">Downloads, all time</p>
        </div>
        <div className="stat">
          <p className="stat__value">{formatCount(stats.downloadsLast7Days)}</p>
          <p className="stat__label">Downloads, last 7 days</p>
        </div>
        <div className="stat">
          <p className="stat__value">{formatBytes(stats.storedBytes)}</p>
          <p className="stat__label">Audio stored</p>
        </div>
      </div>

      <div className="card">
        <h2 className="card__title">Downloads, last 30 days</h2>
        <div className="spark" role="img" aria-label={`Daily downloads, peak ${peak}`}>
          {daily.map((day) => (
            <div
              key={day.day}
              className="spark__bar"
              data-empty={day.downloads === 0}
              style={{ height: `${Math.max(2, (day.downloads / peak) * 100)}%` }}
              title={`${day.day}: ${day.downloads}`}
            />
          ))}
        </div>
        <p className="table__sub" style={{ marginTop: 'var(--s-3)' }}>
          {formatCount(stats.downloadsLast30Days)} downloads in the last 30 days.
        </p>
      </div>

      <div className="form-grid form-grid--2">
        <section className="card">
          <h2 className="card__title">Most downloaded</h2>
          {popular.length === 0 ? (
            <p className="table__sub">No downloads recorded yet.</p>
          ) : (
            <ul className="stack">
              {popular.map((track) => (
                <li key={track.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
                  <Link href={`/song/${track.slug}`} className="table__title" style={{ minWidth: 0 }}>
                    {track.title}
                    <span className="table__sub" style={{ display: 'block' }}>
                      {[track.artist, track.categoryName].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </Link>
                  <span className="table__num">{formatCount(track.downloadCount)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="card__title">Recently added</h2>
          {recent.length === 0 ? (
            <p className="table__sub">Nothing uploaded yet.</p>
          ) : (
            <ul className="stack">
              {recent.map((track) => (
                <li key={track.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
                  <Link href={`/admin/songs/${track.id}`} className="table__title" style={{ minWidth: 0 }}>
                    {track.title}
                    <span className="table__sub" style={{ display: 'block' }}>
                      {track.categoryName ?? 'Uncategorised'} · {formatDate(track.createdAt)}
                    </span>
                  </Link>
                  <span className={`badge ${track.isPublished ? 'badge--live' : 'badge--draft'}`}>
                    {track.isPublished ? 'Live' : 'Draft'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
