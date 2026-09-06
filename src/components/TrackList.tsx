'use client';

import Link from 'next/link';
import { memo, useState } from 'react';

import { DownloadIcon, PauseIcon, PlayIcon, SpinnerIcon } from '@/components/icons';
import { useIsCurrent, usePlayback } from '@/components/player/hooks';
import { formatTime, toggleTrack } from '@/components/player/store';
import type { PublicAudio } from '@/lib/serializers';

/**
 * The track list.
 *
 * `TrackRow` is memoised and subscribes only to "am I the current track", so
 * starting playback re-renders exactly two rows — the one stopping and the one
 * starting — no matter how long the list is.
 */

export function TrackList({
  tracks,
  emptyTitle = 'Nothing here yet',
  emptyBody,
}: {
  tracks: readonly PublicAudio[];
  emptyTitle?: string;
  emptyBody?: string;
}) {
  if (tracks.length === 0) {
    return (
      <div className="state">
        <span className="state__glyph" aria-hidden="true">
          ♪
        </span>
        <p className="state__title">{emptyTitle}</p>
        {emptyBody ? <p className="state__body">{emptyBody}</p> : null}
      </div>
    );
  }

  return (
    <ul className="tracks">
      {tracks.map((track, index) => (
        <TrackRow key={track.id} track={track} index={index} />
      ))}
    </ul>
  );
}

const TrackRow = memo(function TrackRow({ track, index }: { track: PublicAudio; index: number }) {
  const { isCurrent, isPlaying } = useIsCurrent(track.id);

  return (
    <li
      className="track enter"
      data-active={isCurrent}
      // Cap the stagger: past a dozen rows the delay stops reading as
      // choreography and starts reading as lag.
      style={{ animationDelay: `${Math.min(index, 12) * 22}ms` }}
    >
      <PlayButton track={track} isCurrent={isCurrent} isPlaying={isPlaying} />

      <div className="track__body">
        <Link href={`/song/${track.slug}`} className="track__title">
          {track.title}
        </Link>
        <p className="track__meta">
          {track.artist ? <span>{track.artist}</span> : null}
          {track.artist && track.category ? <span aria-hidden="true">·</span> : null}
          {track.category ? <span>{track.category.name}</span> : null}
          <span aria-hidden="true">·</span>
          <span>{track.format}</span>
        </p>
      </div>

      <div className="track__actions">
        {track.durationSec ? (
          <span className="track__duration">{formatTime(track.durationSec)}</span>
        ) : null}
        <DownloadButton track={track} />
      </div>
    </li>
  );
});

function PlayButton({
  track,
  isCurrent,
  isPlaying,
}: {
  track: PublicAudio;
  isCurrent: boolean;
  isPlaying: boolean;
}) {
  const { isLoading } = usePlayback();
  const busy = isCurrent && isLoading;

  return (
    <button
      type="button"
      className="track__play"
      onClick={() => void toggleTrack(track)}
      aria-label={isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
    >
      {busy ? <SpinnerIcon size={18} /> : isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
    </button>
  );
}

/**
 * Download.
 *
 * A plain `<a download>` to a same-origin endpoint — the browser's own download
 * machinery, so it resumes, shows in the download shelf, and works with the
 * page's back button. The brief flash of state is only feedback; the navigation
 * is not intercepted.
 */
export function DownloadButton({
  track,
  variant = 'icon',
}: {
  track: PublicAudio;
  variant?: 'icon' | 'button';
}) {
  const [confirmed, setConfirmed] = useState(false);

  const onClick = () => {
    setConfirmed(true);
    window.setTimeout(() => setConfirmed(false), 1200);
  };

  if (variant === 'button') {
    return (
      <a
        className={`btn btn--primary${confirmed ? ' btn--confirmed' : ''}`}
        href={track.downloadUrl}
        download
        onClick={onClick}
      >
        <DownloadIcon size={18} />
        {confirmed ? 'Starting…' : 'Download'}
      </a>
    );
  }

  return (
    <a
      className={`icon-btn${confirmed ? ' btn--confirmed' : ''}`}
      href={track.downloadUrl}
      download
      onClick={onClick}
      aria-label={`Download ${track.title}`}
    >
      <DownloadIcon size={18} />
    </a>
  );
}
