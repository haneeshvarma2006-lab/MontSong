'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { SpinnerIcon } from '@/components/icons';
import { AUDIO_TYPE_LABELS, AUDIO_TYPES, type AudioType } from '@/lib/constants';
import { formatBytes, formatCount, formatDate, formatDuration } from '@/lib/format';
import type { AdminAudio, AdminCategory } from '@/lib/serializers';

import { AdminApiError, api, uploadWithProgress } from './api';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Edit a track's metadata, artwork and publication state.
 *
 * The audio file itself is deliberately not replaceable in place: swapping the
 * bytes under a URL that visitors have already cached and shared is a worse
 * outcome than uploading a new track and deleting the old one, and it would
 * invalidate the ETag contract the streaming layer relies on.
 */
export function SongEditor({
  audio: initial,
  categories,
}: {
  audio: AdminAudio;
  categories: AdminCategory[];
}) {
  const router = useRouter();
  const coverInputRef = useRef<HTMLInputElement>(null);

  const [audio, setAudio] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [slug, setSlug] = useState(initial.slug);
  const [artist, setArtist] = useState(initial.artist ?? '');
  const [type, setType] = useState<AudioType>((initial.type as AudioType) ?? 'song');
  const [categoryId, setCategoryId] = useState(initial.categoryId ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [isPublished, setIsPublished] = useState(initial.isPublished);
  const [isFeatured, setIsFeatured] = useState(initial.isFeatured);

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      const result = await api.patch<{ audio: AdminAudio }>(`/api/admin/audio/${audio.id}`, {
        title: title.trim(),
        slug: slug.trim(),
        artist: artist.trim(),
        type,
        categoryId: categoryId || null,
        description: description.trim(),
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        isPublished,
        isFeatured,
      });

      setAudio(result.audio);
      setSlug(result.audio.slug);
      setSavedAt(Date.now());
      router.refresh();
    } catch (caught) {
      if (caught instanceof AdminApiError) {
        setError(caught.message);
        if (caught.details) setFieldErrors(caught.details);
      } else {
        setError('Those changes could not be saved.');
      }
    } finally {
      setSaving(false);
    }
  };

  const replaceCover = async (file: File) => {
    setCoverBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('cover', file, file.name);
      const result = await uploadWithProgress<{ audio: AdminAudio | null }>(
        `/api/admin/audio/${audio.id}/cover`,
        form,
        () => undefined,
      );
      if (result.audio) setAudio(result.audio);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'The artwork could not be saved.');
    } finally {
      setCoverBusy(false);
    }
  };

  const removeCover = async () => {
    setCoverBusy(true);
    setError(null);
    try {
      const result = await api.delete<{ audio: AdminAudio | null }>(
        `/api/admin/audio/${audio.id}/cover`,
      );
      if (result.audio) setAudio(result.audio);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'The artwork could not be removed.');
    } finally {
      setCoverBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setSaving(true);
    try {
      await api.delete(`/api/admin/audio/${audio.id}`);
      router.push('/admin/songs');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'That track could not be deleted.');
      setSaving(false);
    }
  };

  return (
    <div className="stack-lg">
      {error ? (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      ) : null}
      {savedAt ? (
        <p className="banner banner--success" role="status" key={savedAt}>
          Saved.
        </p>
      ) : null}

      <div className="card">
        <h2 className="card__title">Preview</h2>
        <audio
          controls
          preload="none"
          src={audio.streamUrl}
          style={{ width: '100%' }}
          aria-label={`Preview ${audio.title}`}
        />
        <dl className="song__facts" style={{ marginTop: 'var(--s-4)' }}>
          <div className="song__fact">
            <strong>{audio.format}</strong>
            Format
          </div>
          <div className="song__fact">
            <strong>{formatBytes(audio.fileSize)}</strong>
            Size
          </div>
          <div className="song__fact">
            <strong>{formatDuration(audio.durationSec)}</strong>
            Length
          </div>
          <div className="song__fact">
            <strong>{formatCount(audio.downloadCount)}</strong>
            Downloads
          </div>
          <div className="song__fact">
            <strong>{formatCount(audio.playCount)}</strong>
            Plays
          </div>
          <div className="song__fact">
            <strong>{formatDate(audio.createdAt)}</strong>
            Added
          </div>
        </dl>
      </div>

      <form className="stack-lg" onSubmit={save} noValidate>
        <div className="form-grid form-grid--2">
          <div className="field">
            <label className="field__label" htmlFor="edit-title">
              Title
            </label>
            <input
              id="edit-title"
              className="field__input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-invalid={Boolean(fieldErrors.title)}
              required
            />
            {fieldErrors.title ? <p className="field__error">{fieldErrors.title[0]}</p> : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="edit-artist">
              Artist
            </label>
            <input
              id="edit-artist"
              className="field__input"
              value={artist}
              onChange={(event) => setArtist(event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="edit-slug">
              Address
            </label>
            <input
              id="edit-slug"
              className="field__input"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              aria-invalid={Boolean(fieldErrors.slug)}
              spellCheck={false}
            />
            <p className="field__hint">/song/{slug || '…'}</p>
            {fieldErrors.slug ? <p className="field__error">{fieldErrors.slug[0]}</p> : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="edit-category">
              Category
            </label>
            <select
              id="edit-category"
              className="field__select"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">Uncategorised</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="edit-type">
              Kind
            </label>
            <select
              id="edit-type"
              className="field__select"
              value={type}
              onChange={(event) => setType(event.target.value as AudioType)}
            >
              {AUDIO_TYPES.map((value) => (
                <option key={value} value={value}>
                  {AUDIO_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="edit-tags">
              Tags
            </label>
            <input
              id="edit-tags"
              className="field__input"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="vijay, mass, 2010s"
            />
          </div>

          <div className="field form-grid__full">
            <label className="field__label" htmlFor="edit-description">
              Description
            </label>
            <textarea
              id="edit-description"
              className="field__textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </div>

          <div className="field form-grid__full">
            <span className="field__label">Artwork</span>
            <div className="filepick">
              {audio.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${audio.coverUrl}?v=${audio.updatedAt}`}
                  alt=""
                  width={56}
                  height={56}
                  style={{ width: 56, height: 56, borderRadius: 'var(--r-md)', objectFit: 'cover' }}
                />
              ) : null}
              <div className="filepick__body">
                <p className="filepick__name">{audio.coverUrl ? 'Artwork set' : 'No artwork'}</p>
                <p className="filepick__meta">JPEG, PNG or WebP</p>
              </div>
              {coverBusy ? (
                <SpinnerIcon size={18} />
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => coverInputRef.current?.click()}
                  >
                    {audio.coverUrl ? 'Replace' : 'Add'}
                  </button>
                  {audio.coverUrl ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void removeCover()}
                    >
                      Remove
                    </button>
                  ) : null}
                </>
              )}
            </div>
            <input
              ref={coverInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="visually-hidden"
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) void replaceCover(chosen);
                event.target.value = '';
              }}
              tabIndex={-1}
            />
          </div>

          <label className="switch">
            <input
              type="checkbox"
              checked={isPublished}
              onChange={(event) => setIsPublished(event.target.checked)}
            />
            Published
          </label>

          <label className="switch">
            <input
              type="checkbox"
              checked={isFeatured}
              onChange={(event) => setIsFeatured(event.target.checked)}
            />
            Featured on the homepage
          </label>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-2)' }}>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? <SpinnerIcon size={18} /> : null}
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <a className="btn btn--ghost" href={`/song/${audio.slug}`} target="_blank" rel="noreferrer">
            View on the site
          </a>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => setConfirmDelete(true)}
            style={{ marginLeft: 'auto' }}
          >
            Delete track
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${audio.title}”?`}
        body="The track and its stored file will both be removed. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
