'use client';

import { useSyncExternalStore } from 'react';

import { playbackStore, progressStore, type PlaybackState, type ProgressState } from './store';

/**
 * Subscriptions to the playback stores.
 *
 * `useSyncExternalStore` needs a snapshot that is referentially stable between
 * notifications, which is why the stores replace their whole state object on
 * every change rather than mutating it — the identity comparison is then the
 * change check.
 *
 * The server snapshot is a frozen constant: nothing plays during server
 * rendering, and returning a fresh object there would loop.
 */

const SERVER_PLAYBACK: PlaybackState = Object.freeze({
  track: null,
  isPlaying: false,
  isLoading: false,
  error: null,
  volume: 1,
  muted: false,
});

const SERVER_PROGRESS: ProgressState = Object.freeze({
  currentTime: 0,
  duration: 0,
  buffered: 0,
});

export function usePlayback(): PlaybackState {
  return useSyncExternalStore(playbackStore.subscribe, playbackStore.get, () => SERVER_PLAYBACK);
}

export function useProgress(): ProgressState {
  return useSyncExternalStore(progressStore.subscribe, progressStore.get, () => SERVER_PROGRESS);
}

/**
 * The narrow subscription a track row needs: is *this* track the one playing?
 *
 * The snapshot is a plain boolean, so a row only re-renders when its own answer
 * changes — a hundred rows on screen produce two re-renders when playback moves
 * from one track to another, not a hundred.
 */
export function useIsCurrent(trackId: string): { isCurrent: boolean; isPlaying: boolean } {
  const isCurrent = useSyncExternalStore(
    playbackStore.subscribe,
    () => playbackStore.get().track?.id === trackId,
    () => false,
  );

  const isPlaying = useSyncExternalStore(
    playbackStore.subscribe,
    () => playbackStore.get().track?.id === trackId && playbackStore.get().isPlaying,
    () => false,
  );

  return { isCurrent, isPlaying };
}
