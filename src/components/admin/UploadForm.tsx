'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { SpinnerIcon } from '@/components/icons';
import { AUDIO_TYPE_LABELS, AUDIO_TYPES, type AudioType } from '@/lib/constants';
import { formatBytes, formatDuration } from '@/lib/format';
import type { AdminAudio, AdminCategory } from '@/lib/serializers';

import { AdminApiError, uploadWithProgress } from './api';

/**
 * Upload a track.
 *
 * Two details worth explaining:
 *
 * **Duration is measured here, in the browser.** Telegram reports a duration
 * for MP3 and M4A (which go through `sendAudio`) but not for the formats stored
 * as documents. Rather than run a server-side probe or leave FLAC and WAV
 * without a duration, the file is loaded into a throwaway `<audio>` element
 * before upload and its `duration` is sent as a field. The server validates it
 * like any other input.
 *
 * **Progress uses XMLHttpRequest.** `fetch` cannot report request progress, and
 * a 20 MB upload with no feedback reads as a hang.
 *
 * Client-side checks here are for speed of feedback only; the server re-derives
 * everything from the bytes and would reject the same files.
 */

const ACCEPT = '.mp3,.m4a,.aac,.ogg,.opus,.wav,.flac,audio/*';

interface Fields {
  title: string;
  artist: string;
  type: AudioType;
  categoryId: string;
  description: string;
  tags: string;
  isPublished: boolean;
  isFeatured: boolean;
}

const EMPTY: Fields = {
  title: '',
  artist: '',
  type: 'song',
  categoryId: '',
  description: '',
  tags: '',
  isPublished: true,
  isFeatured: false,
};

export function UploadForm({
  categories,
  maxAudioBytes,
}: {
  categories: AdminCategory[];
  maxAudioBytes: number;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [file, setFile] = useState<File | null>(null);
  /**
   * The chosen artwork and its object URL are one value, created together in
   * the change handler and revoked together — rather than a file in state and a
   * URL an effect tries to keep in step with it, which renders twice and leaks
   * the URL if the two ever disagree.
   */
  const [cover, setCoverState] = useState<{ file: File; url: string } | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [done, setDone] = useState<AdminAudio | null>(null);

  /**
   * The live object URL, mirrored into a ref so the unmount cleanup below can
   * revoke it. Written only from this handler — never during render.
   */
  const coverUrlRef = useRef<string | null>(null);

  const setCover = useCallback((next: File | null) => {
    if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current);
    const url = next ? URL.createObjectURL(next) : null;
    coverUrlRef.current = url;
    setCoverState(next && url ? { file: next, url } : null);
  }, []);

  // Release the last object URL when the form goes away.
  useEffect(
    () => () => {
      if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current);
      coverUrlRef.current = null;
    },
    [],
  );

  const acceptFile = useCallback(
    (next: File) => {
      setError(null);

      if (next.size > maxAudioBytes) {
        setError(
          `That file is ${formatBytes(next.size)}. The limit for this site is ${formatBytes(maxAudioBytes)}.`,
        );
        return;
      }

      setFile(next);
      setDuration(null);

      // Guess a title from the filename, so the common case is one field less.
      setFields((current) =>
        current.title
          ? current
          : { ...current, title: next.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() },
      );

      // Read the duration without a server round trip.
      const probe = document.createElement('audio');
      probe.preload = 'metadata';
      const url = URL.createObjectURL(next);
      probe.src = url;
      probe.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(probe.duration)) setDuration(Math.round(probe.duration));
        URL.revokeObjectURL(url);
      });
      probe.addEventListener('error', () => {
        // A duration we cannot read is not an error — it is simply absent.
        URL.revokeObjectURL(url);
      });
    },
    [maxAudioBytes],
  );

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) acceptFile(dropped);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || uploading) return;

    setError(null);
    setFieldErrors({});
    setUploading(true);
    setProgress(0);

    const form = new FormData();
    form.append('audio', file, file.name);
    if (cover) form.append('cover', cover.file, cover.file.name);
    form.append(
      'metadata',
      JSON.stringify({
        title: fields.title.trim(),
        artist: fields.artist.trim() || undefined,
        type: fields.type,
        categoryId: fields.categoryId || undefined,
        description: fields.description.trim() || undefined,
        tags: fields.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        isPublished: fields.isPublished,
        isFeatured: fields.isFeatured,
        ...(duration !== null ? { durationSec: duration } : {}),
      }),
    );

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await uploadWithProgress<{ audio: AdminAudio }>(
        '/api/admin/audio',
        form,
        setProgress,
        controller.signal,
      );
      setDone(result.audio);
      router.refresh();
    } catch (caught) {
      if (caught instanceof AdminApiError) {
        setError(caught.diagnostic ? `${caught.message} (${caught.diagnostic})` : caught.message);
        if (caught.details) setFieldErrors(caught.details);
      } else {
        setError('The upload failed. Please try again.');
      }
    } finally {
      setUploading(false);
      abortRef.current = null;
    }
  };

  const reset = () => {
    setFile(null);
    setCover(null);
    setDuration(null);
    setFields(EMPTY);
    setProgress(0);
    setDone(null);
    setError(null);
    setFieldErrors({});
  };

  if (done) {
    return (
      <div className="card stack">
        <p className="banner banner--success" role="status">
          “{done.title}” is stored and {done.isPublished ? 'live on the site' : 'saved as a draft'}.
        </p>

        <audio
          controls
          preload="none"
          src={done.streamUrl}
          style={{ width: '100%' }}
          aria-label={`Preview ${done.title}`}
        />

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-2)' }}>
          <button type="button" className="btn btn--primary" onClick={reset}>
            Upload another
          </button>
          <a className="btn btn--ghost" href={`/admin/songs/${done.id}`}>
            Edit details
          </a>
          <a className="btn btn--ghost" href={`/song/${done.slug}`} target="_blank" rel="noreferrer">
            View on the site
          </a>
        </div>
      </div>
    );
  }

  return (
    <form className="stack-lg" onSubmit={submit} noValidate>
      {error ? (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      ) : null}

      {!file ? (
        <div
          className="dropzone"
          data-dragging={dragging}
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p className="dropzone__title">Drop an audio file here</p>
          <p className="dropzone__hint">
            or click to choose one · MP3, M4A, AAC, OGG, Opus, WAV or FLAC · up to{' '}
            {formatBytes(maxAudioBytes)}
          </p>
        </div>
      ) : (
        <div className="filepick">
          <div className="filepick__body">
            <p className="filepick__name">{file.name}</p>
            <p className="filepick__meta">
              {formatBytes(file.size)}
              {duration !== null ? ` · ${formatDuration(duration)}` : ''}
            </p>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setFile(null)}
            disabled={uploading}
          >
            Change
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="visually-hidden"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          if (chosen) acceptFile(chosen);
          event.target.value = '';
        }}
        tabIndex={-1}
      />

      <div className="form-grid form-grid--2">
        <div className="field">
          <label className="field__label" htmlFor="up-title">
            Title
          </label>
          <input
            id="up-title"
            className="field__input"
            value={fields.title}
            onChange={(event) => setFields({ ...fields, title: event.target.value })}
            aria-invalid={Boolean(fieldErrors.title)}
            required
          />
          {fieldErrors.title ? <p className="field__error">{fieldErrors.title[0]}</p> : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="up-artist">
            Artist
          </label>
          <input
            id="up-artist"
            className="field__input"
            value={fields.artist}
            onChange={(event) => setFields({ ...fields, artist: event.target.value })}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="up-category">
            Category
          </label>
          <select
            id="up-category"
            className="field__select"
            value={fields.categoryId}
            onChange={(event) => setFields({ ...fields, categoryId: event.target.value })}
          >
            <option value="">Uncategorised</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          {categories.length === 0 ? (
            <p className="field__hint">
              No categories yet — create one first and this track can go straight into it.
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="up-type">
            Kind
          </label>
          <select
            id="up-type"
            className="field__select"
            value={fields.type}
            onChange={(event) => setFields({ ...fields, type: event.target.value as AudioType })}
          >
            {AUDIO_TYPES.map((value) => (
              <option key={value} value={value}>
                {AUDIO_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div className="field form-grid__full">
          <label className="field__label" htmlFor="up-description">
            Description
          </label>
          <textarea
            id="up-description"
            className="field__textarea"
            value={fields.description}
            onChange={(event) => setFields({ ...fields, description: event.target.value })}
            rows={3}
          />
        </div>

        <div className="field form-grid__full">
          <label className="field__label" htmlFor="up-tags">
            Tags
          </label>
          <input
            id="up-tags"
            className="field__input"
            value={fields.tags}
            onChange={(event) => setFields({ ...fields, tags: event.target.value })}
            placeholder="vijay, mass, 2010s"
          />
          <p className="field__hint">Separate with commas. Tags are searchable.</p>
        </div>

        <div className="field form-grid__full">
          <span className="field__label">Artwork (optional)</span>
          <div className="filepick">
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={cover.url}
                alt=""
                width={56}
                height={56}
                style={{ width: 56, height: 56, borderRadius: 'var(--r-md)', objectFit: 'cover' }}
              />
            ) : null}
            <div className="filepick__body">
              <p className="filepick__name">{cover ? cover.file.name : 'No image chosen'}</p>
              <p className="filepick__meta">
                {cover ? formatBytes(cover.file.size) : 'JPEG, PNG or WebP'}
              </p>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => coverInputRef.current?.click()}
              disabled={uploading}
            >
              {cover ? 'Change' : 'Choose'}
            </button>
            {cover ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setCover(null)}
                disabled={uploading}
              >
                Remove
              </button>
            ) : null}
          </div>
          <input
            ref={coverInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="visually-hidden"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (chosen) setCover(chosen);
              event.target.value = '';
            }}
            tabIndex={-1}
          />
        </div>

        <label className="switch">
          <input
            type="checkbox"
            checked={fields.isPublished}
            onChange={(event) => setFields({ ...fields, isPublished: event.target.checked })}
          />
          Publish immediately
        </label>

        <label className="switch">
          <input
            type="checkbox"
            checked={fields.isFeatured}
            onChange={(event) => setFields({ ...fields, isFeatured: event.target.checked })}
          />
          Feature on the homepage
        </label>
      </div>

      {uploading ? (
        <div className="stack">
          <div className="progress">
            <div className="progress__bar" style={{ '--value': progress } as React.CSSProperties} />
          </div>
          <p className="table__sub" aria-live="polite">
            {progress < 1
              ? `Uploading… ${Math.round(progress * 100)}%`
              : 'Storing the file — this can take a moment.'}
          </p>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
        <button type="submit" className="btn btn--primary" disabled={!file || uploading || !fields.title.trim()}>
          {uploading ? <SpinnerIcon size={18} /> : null}
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
        {uploading ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => abortRef.current?.abort()}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
