import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { SongActions } from '@/components/SongActions';
import { TrackList } from '@/components/TrackList';
import { formatBytes, formatDuration } from '@/lib/format';
import { getAudioBySlug, listPublicAudio } from '@/lib/repositories/audio';
import { toPublicAudio } from '@/lib/serializers';
import { getSiteCopy, siteUrl } from '@/lib/site';

/**
 * A single track.
 *
 * This is the page that gets shared, so it carries the full metadata set —
 * canonical URL, Open Graph, Twitter card, and a `MusicRecording` JSON-LD block.
 *
 * What it does *not* carry is anything about where the file actually lives. The
 * structured data points at this site's own stream and download endpoints; the
 * serialiser has no Telegram fields to leak even if a future edit tried.
 */
export const dynamic = 'force-dynamic';

function durationIso(seconds: number | null): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `PT${minutes}M${remainder}S`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const [audio, copy] = await Promise.all([
    getAudioBySlug(slug, { publishedOnly: true }),
    getSiteCopy(),
  ]);

  if (!audio) return { title: 'Not found', robots: { index: false, follow: false } };

  const title = audio.artist ? `${audio.title} — ${audio.artist}` : audio.title;
  const description =
    audio.description ??
    `Listen to ${audio.title}${audio.artist ? ` by ${audio.artist}` : ''} and download it free from ${copy.name}.`;

  return {
    title,
    description,
    alternates: { canonical: `/song/${audio.slug}` },
    openGraph: {
      type: 'music.song',
      title,
      description,
      url: siteUrl(`/song/${audio.slug}`),
      images: audio.coverMediaId ? [siteUrl(`/api/audio/${audio.id}/cover`)] : undefined,
    },
    twitter: {
      card: audio.coverMediaId ? 'summary_large_image' : 'summary',
      title,
      description,
    },
  };
}

export default async function SongPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const audio = await getAudioBySlug(slug, { publishedOnly: true });
  if (!audio) notFound();

  const track = toPublicAudio(audio);

  const related = audio.categoryId
    ? (await listPublicAudio({ categoryId: audio.categoryId, limit: 9, orderBy: 'order' }))
        .filter((item) => item.id !== audio.id)
        .slice(0, 8)
    : [];

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'MusicRecording',
    name: audio.title,
    url: siteUrl(`/song/${audio.slug}`),
    ...(audio.artist ? { byArtist: { '@type': 'MusicGroup', name: audio.artist } } : {}),
    ...(audio.description ? { description: audio.description } : {}),
    ...(durationIso(audio.media.durationSec) ? { duration: durationIso(audio.media.durationSec) } : {}),
    ...(audio.category ? { genre: audio.category.name } : {}),
    audio: {
      '@type': 'AudioObject',
      contentUrl: siteUrl(track.downloadUrl),
      encodingFormat: audio.media.mimeType,
      ...(audio.media.durationSec ? { duration: durationIso(audio.media.durationSec) } : {}),
    },
  };

  return (
    <div className="page page--narrow">
      <script
        type="application/ld+json"
        // Serialised from our own database rows, and `<` is escaped so no title
        // can close the script element early.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
        }}
      />

      <article className="song">
        <div>
          {track.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="song__art"
              src={track.coverUrl}
              alt=""
              width={240}
              height={240}
              loading="eager"
              decoding="async"
            />
          ) : (
            <div className="song__art">
              <span className="song__art-placeholder" aria-hidden="true">
                ♪
              </span>
            </div>
          )}
        </div>

        <div>
          <p className="song__eyebrow">
            {audio.category ? (
              <Link href={`/category/${audio.category.slug}`} className="chip chip--accent">
                {audio.category.name}
              </Link>
            ) : null}
            <span>{track.format}</span>
          </p>

          <h1 className="song__title">{audio.title}</h1>
          {audio.artist ? <p className="song__artist">{audio.artist}</p> : null}

          {audio.description ? <p className="song__description">{audio.description}</p> : null}

          <SongActions track={track} />

          {track.tags.length > 0 ? (
            <ul className="filters" style={{ marginTop: 'var(--s-5)' }}>
              {track.tags.map((tag) => (
                <li key={tag}>
                  <Link href={`/search?q=${encodeURIComponent(tag)}`} className="chip">
                    {tag}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          <dl className="song__facts">
            {audio.media.durationSec ? (
              <div className="song__fact">
                <strong>{formatDuration(audio.media.durationSec)}</strong>
                Length
              </div>
            ) : null}
            <div className="song__fact">
              <strong>{formatBytes(audio.media.fileSize)}</strong>
              Size
            </div>
            <div className="song__fact">
              <strong>{track.format}</strong>
              Format
            </div>
            <div className="song__fact">
              <strong>{audio.downloadCount.toLocaleString()}</strong>
              {audio.downloadCount === 1 ? 'Download' : 'Downloads'}
            </div>
          </dl>
        </div>
      </article>

      {related.length > 0 ? (
        <section className="section" aria-labelledby="related-heading">
          <div className="section__head">
            <h2 className="section__title" id="related-heading">
              More from {audio.category?.name}
            </h2>
            {audio.category ? (
              <Link href={`/category/${audio.category.slug}`} className="section__link">
                See all →
              </Link>
            ) : null}
          </div>
          <TrackList tracks={related.map(toPublicAudio)} />
        </section>
      ) : null}
    </div>
  );
}
