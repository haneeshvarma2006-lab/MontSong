'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SpinnerIcon } from '@/components/icons';
import { AUDIO_TYPE_LABELS, type AudioType } from '@/lib/constants';
import { formatCount, formatDate, formatDuration } from '@/lib/format';
import type { AdminAudio, AdminCategory } from '@/lib/serializers';

import { AdminApiError, api } from './api';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * The songs table.
 *
 * Filters live in component state rather than the URL because this is a
 * single-operator tool where a filter is a momentary act, not something to
 * share — and keeping it out of the URL avoids a full server round trip per
 * keystroke. The search field is debounced for the same reason.
 *
 * Every mutation updates the row in place from the server's response, so the
 * table always shows what was actually saved rather than what was optimistically
 * assumed.
 */

interface Page {
  items: AdminAudio[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
}

type Status = 'all' | 'published' | 'unpublished';
type Sort = 'recent' | 'title' | 'downloads' | 'order';

export function SongsTable({ categories }: { categories: AdminCategory[] }) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [type, setType] = useState<AudioType | ''>('');
  const [status, setStatus] = useState<Status>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [page, setPage] = useState(1);

  /**
   * The last completed fetch, tagged with the filter state it answered.
   *
   * Tagging makes "is this list current?" derivable, so `loading` is a computed
   * value rather than a second piece of state that an effect has to keep in
   * step — and a slow response for an abandoned filter can never be mistaken
   * for the current one.
   */
  const [loaded, setLoaded] = useState<{ key: string; data: Page } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminAudio | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const requestKey = useMemo(
    () =>
      JSON.stringify({ page, sort, status, debouncedQuery, categoryId, type, reloadToken }),
    [page, sort, status, debouncedQuery, categoryId, type, reloadToken],
  );

  const data = loaded?.data ?? null;
  const loading = loaded?.key !== requestKey;

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const params = new URLSearchParams({ page: String(page), perPage: '25', sort, status });
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (categoryId) params.set('categoryId', categoryId);
    if (type) params.set('type', type);

    void (async () => {
      try {
        const result = await api.get<Page>(`/api/admin/audio?${params.toString()}`);
        if (controller.signal.aborted) return;
        setLoaded({ key: requestKey, data: result });
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof AdminApiError) setError(caught.message);
        else if ((caught as Error).name !== 'AbortError') setError('Could not load the song list.');
      }
    })();

    return () => controller.abort();
  }, [requestKey, page, sort, status, debouncedQuery, categoryId, type]);

  /** Force a refetch without changing any filter. */
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const replaceRow = useCallback((audio: AdminAudio) => {
    setLoaded((current) =>
      current
        ? {
            ...current,
            data: {
              ...current.data,
              items: current.data.items.map((item) => (item.id === audio.id ? audio : item)),
            },
          }
        : current,
    );
  }, []);

  const togglePublish = async (audio: AdminAudio) => {
    setBusyId(audio.id);
    setError(null);
    try {
      const result = await api.patch<{ audio: AdminAudio }>(
        `/api/admin/audio/${audio.id}?action=publish&value=${!audio.isPublished}`,
      );
      replaceRow(result.audio);
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'That change could not be saved.');
    } finally {
      setBusyId(null);
    }
  };

  const move = async (audio: AdminAudio, nextCategoryId: string) => {
    setBusyId(audio.id);
    setError(null);
    try {
      const result = await api.patch<{ audio: AdminAudio }>(
        `/api/admin/audio/${audio.id}?action=move`,
        { categoryId: nextCategoryId === '' ? null : nextCategoryId },
      );
      replaceRow(result.audio);
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'That move could not be saved.');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    setBusyId(target.id);
    setError(null);

    try {
      const result = await api.delete<{ storageWarnings: string[] }>(
        `/api/admin/audio/${target.id}`,
      );
      setNotice(
        result.storageWarnings.length > 0
          ? `Deleted “${target.title}”. ${result.storageWarnings.join(' ')}`
          : `Deleted “${target.title}”.`,
      );
      reload();
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'That track could not be deleted.');
    } finally {
      setBusyId(null);
    }
  };

  const categoryOptions = useMemo(
    () => categories.map((category) => ({ id: category.id, name: category.name })),
    [categories],
  );

  return (
    <div className="stack-lg">
      {error ? (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="banner banner--success" role="status">
          {notice}
        </p>
      ) : null}

      <div className="stack">
        <div className="field">
          <label className="field__label" htmlFor="song-search">
            Search
          </label>
          <input
            id="song-search"
            className="field__input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, artist, tag…"
            autoComplete="off"
          />
        </div>

        <div className="filter-row">
          <div className="field">
            <label className="field__label" htmlFor="song-category">
              Category
            </label>
            <select
              id="song-category"
              className="field__select"
              value={categoryId}
              onChange={(event) => {
                setCategoryId(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {categoryOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="song-status">
              Status
            </label>
            <select
              id="song-status"
              className="field__select"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as Status);
                setPage(1);
              }}
            >
              <option value="all">All</option>
              <option value="published">Published</option>
              <option value="unpublished">Drafts</option>
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="song-type">
              Kind
            </label>
            <select
              id="song-type"
              className="field__select"
              value={type}
              onChange={(event) => {
                setType(event.target.value as AudioType | '');
                setPage(1);
              }}
            >
              <option value="">Any</option>
              {Object.entries(AUDIO_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="song-sort">
              Sort
            </label>
            <select
              id="song-sort"
              className="field__select"
              value={sort}
              onChange={(event) => setSort(event.target.value as Sort)}
            >
              <option value="recent">Newest</option>
              <option value="title">Title</option>
              <option value="downloads">Downloads</option>
              <option value="order">Manual order</option>
            </select>
          </div>
        </div>
      </div>

      {loading && !data ? (
        <div className="stack">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="skeleton" style={{ height: '3.25rem' }} />
          ))}
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="state">
          <span className="state__glyph" aria-hidden="true">
            ♪
          </span>
          <p className="state__title">No songs match</p>
          <p className="state__body">
            Adjust the filters, or upload something new.
          </p>
          <Link href="/admin/songs/new" className="btn btn--primary" style={{ marginTop: 'var(--s-3)' }}>
            Add a song
          </Link>
        </div>
      ) : data ? (
        <>
          <div className="table-wrap" aria-busy={loading}>
            <table className="table">
              <caption className="visually-hidden">
                Songs in the library, with publication state and download counts
              </caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Category</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="table__num">
                    Downloads
                  </th>
                  <th scope="col">Added</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((audio) => (
                  <tr key={audio.id}>
                    <td>
                      <Link href={`/admin/songs/${audio.id}`} className="table__title">
                        {audio.title}
                      </Link>
                      <span className="table__sub" style={{ display: 'block' }}>
                        {[audio.artist, audio.format, formatDuration(audio.durationSec)]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </td>
                    <td>
                      <select
                        className="field__select"
                        style={{ minHeight: '2.25rem', minWidth: '9rem' }}
                        value={audio.categoryId ?? ''}
                        disabled={busyId === audio.id}
                        onChange={(event) => void move(audio, event.target.value)}
                        aria-label={`Category for ${audio.title}`}
                      >
                        <option value="">Uncategorised</option>
                        {categoryOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{AUDIO_TYPE_LABELS[audio.type as AudioType] ?? audio.type}</td>
                    <td>
                      <span className={`badge ${audio.isPublished ? 'badge--live' : 'badge--draft'}`}>
                        {audio.isPublished ? 'Live' : 'Draft'}
                      </span>
                    </td>
                    <td className="table__num">{formatCount(audio.downloadCount)}</td>
                    <td className="table__sub">{formatDate(audio.createdAt)}</td>
                    <td>
                      <div className="table__actions">
                        {busyId === audio.id ? (
                          <SpinnerIcon size={16} />
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              onClick={() => void togglePublish(audio)}
                            >
                              {audio.isPublished ? 'Unpublish' : 'Publish'}
                            </button>
                            <Link href={`/admin/songs/${audio.id}`} className="btn btn--ghost btn--sm">
                              Edit
                            </Link>
                            <button
                              type="button"
                              className="btn btn--danger btn--sm"
                              onClick={() => setPendingDelete(audio)}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.pageCount > 1 ? (
            <nav className="admin__toolbar" aria-label="Pagination" style={{ marginBottom: 0 }}>
              <p className="table__sub">
                Page {data.page} of {data.pageCount} · {formatCount(data.total)} songs
              </p>
              <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={data.page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={data.page >= data.pageCount}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </button>
              </div>
            </nav>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete “${pendingDelete?.title ?? ''}”?`}
        body="The track and its stored file will both be removed. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
