'use client';

import type { PublicAudio } from '@/lib/serializers';

/**
 * Playback state, kept outside React.
 *
 * The problem this solves: a `timeupdate` event fires roughly four times a
 * second. If progress lived in React state alongside the current track, every
 * row in a 200-track list would re-render four times a second while something
 * played.
 *
 * So there are two independent stores with independent subscriber sets:
 *
 *   `playback` — which track, playing or paused, loading, errored.
 *                Changes rarely. Track rows subscribe to this.
 *   `progress` — current time, duration, buffered.
 *                Changes constantly. Only the mini-player subscribes.
 *
 * Both are read through `useSyncExternalStore`, which gives correct behaviour
 * under concurrent rendering and needs no context provider or reducer.
 */

export interface PlaybackState {
  readonly track: PublicAudio | null;
  readonly isPlaying: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly volume: number;
  readonly muted: boolean;
}

export interface ProgressState {
  readonly currentTime: number;
  readonly duration: number;
  readonly buffered: number;
}

function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    get: (): T => state,
    set(patch: Partial<T>): void {
      let changed = false;
      for (const key of Object.keys(patch) as (keyof T)[]) {
        if (patch[key] !== undefined && !Object.is(state[key], patch[key])) {
          changed = true;
          break;
        }
      }
      // Bail out when nothing actually moved: `timeupdate` fires on a paused
      // element too, and a no-op notification is a wasted render.
      if (!changed) return;
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const VOLUME_KEY = 'montsong:volume';

function initialVolume(): number {
  if (typeof window === 'undefined') return 1;
  try {
    const stored = window.localStorage.getItem(VOLUME_KEY);
    if (stored === null) return 1;
    const value = Number.parseFloat(stored);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
  } catch {
    // Private mode, or storage disabled. A default volume is not worth an error.
    return 1;
  }
}

export const playbackStore = createStore<PlaybackState>({
  track: null,
  isPlaying: false,
  isLoading: false,
  error: null,
  volume: 1,
  muted: false,
});

export const progressStore = createStore<ProgressState>({
  currentTime: 0,
  duration: 0,
  buffered: 0,
});

/**
 * The single `<audio>` element for the whole application.
 *
 * One element is what makes "only one track plays at a time" structurally true
 * rather than a rule the UI has to remember to enforce. It is created lazily so
 * nothing is constructed during server rendering.
 */
let element: HTMLAudioElement | null = null;

export function getAudioElement(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;

  if (!element) {
    element = new Audio();
    element.preload = 'metadata';
    element.volume = initialVolume();
    playbackStore.set({ volume: element.volume });

    element.addEventListener('play', () => playbackStore.set({ isPlaying: true, error: null }));
    element.addEventListener('pause', () => playbackStore.set({ isPlaying: false }));
    element.addEventListener('waiting', () => playbackStore.set({ isLoading: true }));
    element.addEventListener('playing', () => playbackStore.set({ isLoading: false, error: null }));
    element.addEventListener('canplay', () => playbackStore.set({ isLoading: false }));

    element.addEventListener('loadedmetadata', () => {
      progressStore.set({
        duration: Number.isFinite(element?.duration ?? NaN) ? (element?.duration ?? 0) : 0,
      });
    });

    element.addEventListener('timeupdate', () => {
      if (!element) return;
      progressStore.set({
        currentTime: element.currentTime,
        buffered:
          element.buffered.length > 0 ? element.buffered.end(element.buffered.length - 1) : 0,
      });
    });

    element.addEventListener('ended', () => {
      playbackStore.set({ isPlaying: false });
      progressStore.set({ currentTime: 0 });
    });

    element.addEventListener('error', () => {
      playbackStore.set({
        isPlaying: false,
        isLoading: false,
        error: 'This track could not be played. It may have been moved or removed.',
      });
    });

    element.addEventListener('volumechange', () => {
      if (!element) return;
      playbackStore.set({ volume: element.volume, muted: element.muted });
      try {
        window.localStorage.setItem(VOLUME_KEY, String(element.volume));
      } catch {
        /* storage unavailable; volume simply will not persist */
      }
    });
  }

  return element;
}

/**
 * Play a track, or toggle it if it is already the current one.
 *
 * Nothing here autoplays: every path into this function starts with a click or
 * a key press, which is also what browsers require for playback to be allowed.
 */
export async function toggleTrack(track: PublicAudio): Promise<void> {
  const audio = getAudioElement();
  if (!audio) return;

  const current = playbackStore.get().track;

  if (current?.id === track.id) {
    if (audio.paused) {
      await safePlay(audio);
    } else {
      audio.pause();
    }
    return;
  }

  // Switching tracks: reset progress before the new source loads so the
  // mini-player never shows the previous track's position.
  progressStore.set({ currentTime: 0, duration: 0, buffered: 0 });
  playbackStore.set({ track, isLoading: true, error: null });

  audio.src = track.streamUrl;
  audio.load();
  await safePlay(audio);
  updateMediaSession(track);
}

async function safePlay(audio: HTMLAudioElement): Promise<void> {
  try {
    await audio.play();
  } catch (error) {
    // A rejected play() is usually an autoplay-policy refusal or a load that
    // was superseded; neither deserves a scary message.
    if (error instanceof DOMException && error.name === 'AbortError') return;
    playbackStore.set({
      isPlaying: false,
      isLoading: false,
      error: 'Playback could not start. Tap play to try again.',
    });
  }
}

export function pause(): void {
  getAudioElement()?.pause();
}

export function seek(seconds: number): void {
  const audio = getAudioElement();
  if (!audio || !Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(seconds, audio.duration));
  progressStore.set({ currentTime: audio.currentTime });
}

export function setVolume(value: number): void {
  const audio = getAudioElement();
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, value));
  if (audio.volume > 0) audio.muted = false;
}

export function toggleMute(): void {
  const audio = getAudioElement();
  if (!audio) return;
  audio.muted = !audio.muted;
}

export function stop(): void {
  const audio = getAudioElement();
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  playbackStore.set({ track: null, isPlaying: false, isLoading: false, error: null });
  progressStore.set({ currentTime: 0, duration: 0, buffered: 0 });
}

/**
 * Publish the current track to the OS media controls — lock screen, headphone
 * buttons, the notification shade. Cheap to add and it is what makes the site
 * feel like an app on a phone.
 */
function updateMediaSession(track: PublicAudio): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist ?? '',
      album: track.category?.name ?? '',
      artwork: track.coverUrl
        ? [{ src: track.coverUrl, sizes: '512x512', type: 'image/jpeg' }]
        : undefined,
    });

    navigator.mediaSession.setActionHandler('play', () => {
      void getAudioElement()?.play();
    });
    navigator.mediaSession.setActionHandler('pause', () => pause());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) seek(details.seekTime);
    });
  } catch {
    /* MediaSession is best effort; a failure must never break playback */
  }
}

/** Format seconds as m:ss, or -:-- when the duration is not known yet. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-:--';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}
