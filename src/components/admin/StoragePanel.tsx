'use client';

import { useCallback, useEffect, useState } from 'react';

import { SpinnerIcon } from '@/components/icons';
import { formatBytes, formatDate } from '@/lib/format';

import { AdminApiError, api } from './api';

/**
 * Storage diagnostics and reconciliation.
 *
 * This screen exists because the storage layer spans two systems, and when
 * something goes wrong across a boundary the owner needs to see exactly what
 * state things are in and be able to fix it — not be told "upload failed" and
 * left wondering whether a file is sitting somewhere unreferenced.
 */

interface StorageReport {
  mode: 'cloud' | 'local-server';
  limits: {
    maxAudioBytes: number;
    maxImageBytes: number;
    telegramCeilingBytes: number;
    explanation: string;
  };
  cache: { files: number; bytes: number; budgetBytes: number };
  orphans: {
    id: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    status: string;
    error: string | null;
    createdAt: string;
    hasStoredFile: boolean;
  }[];
  warnings: string[];
}

interface ConnectionReport {
  ok: boolean;
  bot?: { id: number; username?: string; name: string };
  chat?: { id: string; type: string; title?: string };
  mode: string;
  maxUploadBytes: number;
  errors: string[];
  warnings: string[];
}

export function StoragePanel() {
  /**
   * Tagged with the refresh it answered, so `loading` is derived rather than a
   * second piece of state kept in step by an effect.
   */
  const [loaded, setLoaded] = useState<{ token: number; report: StorageReport } | null>(null);
  const [token, setToken] = useState(0);
  const [connection, setConnection] = useState<ConnectionReport | null>(null);
  const [testing, setTesting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const report = loaded?.report ?? null;
  const loading = loaded?.token !== token;

  /** Ask for a fresh report. The effect below does the fetching. */
  const load = useCallback(() => setToken((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await api.get<StorageReport>('/api/admin/storage');
        if (cancelled) return;
        setLoaded({ token, report: result });
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof AdminApiError ? caught.message : 'Could not read storage status.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const test = async () => {
    setTesting(true);
    setError(null);
    setConnection(null);
    try {
      const result = await api.post<{ report: ConnectionReport }>('/api/admin/storage/test');
      setConnection(result.report);
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'The connection test failed.');
    } finally {
      setTesting(false);
    }
  };

  const clearCache = async () => {
    setError(null);
    try {
      const result = await api.delete<{ cleared: number }>('/api/admin/storage/cache');
      setNotice(`Cleared ${result.cleared} cached ${result.cleared === 1 ? 'file' : 'files'}.`);
      load();
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'The cache could not be cleared.');
    }
  };

  const adopt = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/api/admin/storage/orphans/${id}`);
      setNotice('Recovered. The file is now tracked and can be attached to a song.');
      load();
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'That upload could not be recovered.');
    } finally {
      setBusyId(null);
    }
  };

  const discard = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const result = await api.delete<{ storageDeleted: boolean }>(
        `/api/admin/storage/orphans/${id}`,
      );
      setNotice(
        result.storageDeleted
          ? 'Discarded, and the stored copy was removed.'
          : 'Marked as abandoned. The stored copy could not be removed automatically.',
      );
      load();
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'That upload could not be discarded.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !report) {
    return (
      <div className="stack">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="skeleton" style={{ height: '6rem' }} />
        ))}
      </div>
    );
  }

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
      {report?.warnings.map((warning) => (
        <p key={warning} className="banner banner--warning" role="status">
          {warning}
        </p>
      ))}

      <section className="card">
        <h2 className="card__title">Connection</h2>
        <p className="table__sub">
          Mode: <strong>{report?.mode === 'cloud' ? 'Cloud Bot API' : 'Local Bot API server'}</strong>
        </p>
        <p className="table__sub" style={{ marginTop: 'var(--s-2)' }}>
          {report?.limits.explanation}
        </p>
        <p className="table__sub" style={{ marginTop: 'var(--s-2)' }}>
          Uploads are capped at {formatBytes(report?.limits.maxAudioBytes ?? 0)} for audio and{' '}
          {formatBytes(report?.limits.maxImageBytes ?? 0)} for artwork.
        </p>

        <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-4)' }}>
          <button type="button" className="btn btn--ghost" onClick={() => void test()} disabled={testing}>
            {testing ? <SpinnerIcon size={16} /> : null}
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>

        {connection ? (
          <div style={{ marginTop: 'var(--s-4)' }}>
            <p className={`banner ${connection.ok ? 'banner--success' : 'banner--error'}`} role="status">
              {connection.ok
                ? `Connected as ${connection.bot?.username ? `@${connection.bot.username}` : connection.bot?.name}${
                    connection.chat?.title ? ` · storing in “${connection.chat.title}”` : ''
                  }.`
                : 'The storage connection is not working.'}
            </p>
            {connection.errors.map((message) => (
              <p key={message} className="field__error" style={{ marginTop: 'var(--s-2)' }}>
                {message}
              </p>
            ))}
            {connection.warnings.map((message) => (
              <p key={message} className="field__hint" style={{ marginTop: 'var(--s-2)' }}>
                {message}
              </p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2 className="card__title">Media cache</h2>
        <p className="table__sub">
          {report?.cache.files ?? 0} {report?.cache.files === 1 ? 'file' : 'files'} ·{' '}
          {formatBytes(report?.cache.bytes ?? 0)} of {formatBytes(report?.cache.budgetBytes ?? 0)}
        </p>
        <div className="progress" style={{ marginTop: 'var(--s-3)' }}>
          <div
            className="progress__bar"
            style={
              {
                '--value': Math.min(
                  1,
                  (report?.cache.bytes ?? 0) / Math.max(1, report?.cache.budgetBytes ?? 1),
                ),
              } as React.CSSProperties
            }
          />
        </div>
        <p className="field__hint" style={{ marginTop: 'var(--s-3)' }}>
          Cached copies make playback and seeking instant. Clearing is always safe — every file is
          re-fetched from storage the next time it is played.
        </p>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void clearCache()}
          style={{ marginTop: 'var(--s-3)' }}
        >
          Clear cache
        </button>
      </section>

      <section className="card">
        <h2 className="card__title">Unfinished uploads</h2>

        {!report || report.orphans.length === 0 ? (
          <p className="table__sub">
            Nothing unaccounted for. Every upload that reached storage became a track.
          </p>
        ) : (
          <>
            <p className="field__hint" style={{ marginBottom: 'var(--s-4)' }}>
              These uploads did not finish. Any marked “uploaded” are safely in storage and can be
              recovered without uploading again.
            </p>
            <ul className="sortable">
              {report.orphans.map((orphan) => (
                <li key={orphan.id} className="sortable__item">
                  <div className="sortable__body">
                    <p className="sortable__name">{orphan.fileName}</p>
                    <p className="sortable__meta">
                      {formatBytes(orphan.fileSize)} · {orphan.mimeType} ·{' '}
                      {formatDate(orphan.createdAt)}
                      {orphan.error ? ` · ${orphan.error}` : ''}
                    </p>
                  </div>

                  <div className="sortable__actions">
                    <span
                      className={`badge ${
                        orphan.status === 'failed' ? 'badge--draft' : 'badge--warn'
                      }`}
                    >
                      {orphan.status}
                    </span>

                    {busyId === orphan.id ? (
                      <SpinnerIcon size={16} />
                    ) : (
                      <>
                        {orphan.hasStoredFile ? (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => void adopt(orphan.id)}
                          >
                            Recover
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn--danger btn--sm"
                          onClick={() => void discard(orphan.id)}
                        >
                          Discard
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
