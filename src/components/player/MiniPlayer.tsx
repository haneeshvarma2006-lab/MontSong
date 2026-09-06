'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef } from 'react';

import {
  CloseIcon,
  DownloadIcon,
  MuteIcon,
  PauseIcon,
  PlayIcon,
  SpinnerIcon,
  VolumeIcon,
} from '@/components/icons';

import { usePlayback, useProgress } from './hooks';
import { formatTime, pause, seek, setVolume, stop, toggleMute, toggleTrack } from './store';

/**
 * The docked player.
 *
 * Present only while something is loaded, so it never eats screen space on a
 * phone before it has a reason to. `body.has-player` reserves the space it
 * occupies, which keeps the last row of a list reachable instead of hidden
 * behind the bar.
 *
 * This is the only component subscribed to progress, which is what keeps a
 * four-times-a-second update from touching the rest of the page.
 */
export function MiniPlayer() {
  const { track, isPlaying, isLoading, error, volume, muted } = usePlayback();
  const { currentTime, duration, buffered } = useProgress();
  const scrubberRef = useRef<HTMLInputElement>(null);

  // Reserve the bar's height on <body> only while it is mounted.
  useEffect(() => {
    document.body.classList.toggle('has-player', track !== null);
    return () => document.body.classList.remove('has-player');
  }, [track]);

  // Space toggles playback, arrows nudge by five seconds — as long as the
  // listener is not typing into something.
  useEffect(() => {
    if (!track) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName))
      ) {
        return;
      }

      if (event.code === 'Space') {
        event.preventDefault();
        void toggleTrack(track);
      } else if (event.code === 'ArrowRight') {
        seek(currentTime + 5);
      } else if (event.code === 'ArrowLeft') {
        seek(currentTime - 5);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [track, currentTime]);

  const onScrub = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    seek(Number(event.target.value));
  }, []);

  if (!track) return null;

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0;

  return (
    <div className="player" role="region" aria-label="Audio player">
      {error ? (
        <p className="player__error" role="status">
          {error}
        </p>
      ) : null}

      <div
        className="player__scrub"
        style={
          {
            '--played': `${progressPercent}%`,
            '--buffered': `${bufferedPercent}%`,
          } as React.CSSProperties
        }
      >
        <input
          ref={scrubberRef}
          className="player__scrub-input"
          type="range"
          min={0}
          max={duration > 0 ? duration : 0}
          step={0.1}
          value={currentTime}
          onChange={onScrub}
          aria-label="Seek"
          aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
          disabled={duration <= 0}
        />
      </div>

      <div className="player__body">
        <button
          type="button"
          className="player__toggle"
          onClick={() => void toggleTrack(track)}
          aria-label={isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
        >
          {isLoading ? <SpinnerIcon size={22} /> : isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
        </button>

        <div className="player__meta">
          <Link href={`/song/${track.slug}`} className="player__title">
            {track.title}
          </Link>
          <span className="player__sub">
            {track.artist ? <span>{track.artist}</span> : null}
            <span className="player__time" aria-hidden="true">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </span>
        </div>

        <div className="player__controls">
          <div className="player__volume">
            <button
              type="button"
              className="icon-btn"
              onClick={toggleMute}
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted || volume === 0 ? <MuteIcon size={18} /> : <VolumeIcon size={18} />}
            </button>
            <input
              className="player__volume-input"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(event) => setVolume(Number(event.target.value))}
              aria-label="Volume"
            />
          </div>

          <a
            className="icon-btn"
            href={track.downloadUrl}
            download
            aria-label={`Download ${track.title}`}
          >
            <DownloadIcon size={18} />
          </a>

          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              pause();
              stop();
            }}
            aria-label="Close player"
          >
            <CloseIcon size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
