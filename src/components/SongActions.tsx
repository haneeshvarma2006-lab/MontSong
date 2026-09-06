'use client';

import { PauseIcon, PlayIcon, SpinnerIcon } from '@/components/icons';
import { DownloadButton } from '@/components/TrackList';
import { useIsCurrent, usePlayback } from '@/components/player/hooks';
import { toggleTrack } from '@/components/player/store';
import type { PublicAudio } from '@/lib/serializers';

/**
 * Play and download for the song detail page.
 *
 * Split out as the only client component on that page, so the rest of it —
 * title, artwork, description, related tracks, structured data — stays server
 * rendered and ships no JavaScript.
 */
export function SongActions({ track }: { track: PublicAudio }) {
  const { isCurrent, isPlaying } = useIsCurrent(track.id);
  const { isLoading, error } = usePlayback();
  const busy = isCurrent && isLoading;

  return (
    <div>
      <div className="song__actions">
        <button type="button" className="btn btn--primary" onClick={() => void toggleTrack(track)}>
          {busy ? <SpinnerIcon size={18} /> : isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
          {isPlaying ? 'Pause' : isCurrent ? 'Resume' : 'Play'}
        </button>

        <DownloadButton track={track} variant="button" />
      </div>

      {isCurrent && error ? (
        <p className="banner banner--error" style={{ marginTop: 'var(--s-4)' }} role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}
