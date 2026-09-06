'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { SpinnerIcon } from '@/components/icons';
import type { AdminCategory } from '@/lib/serializers';

import { AdminApiError, api } from './api';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Category CRUD and ordering.
 *
 * Reordering supports both pointer drag and keyboard arrows. The arrows are not
 * a fallback — drag and drop is unusable without a mouse and awkward on a phone,
 * so the up/down buttons are the primary control and dragging is the shortcut.
 *
 * The order is persisted on drop (or on each nudge) as a single transactional
 * call, and the list reverts if the server rejects it, so what is on screen is
 * never a lie about what is stored.
 */
export function CategoryManager({ initial }: { initial: AdminCategory[] }) {
  const router = useRouter();

  const [items, setItems] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const [editing, setEditing] = useState<AdminCategory | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AdminCategory | null>(null);
  const [deleteTarget, setDeleteTarget] = useState('');

  const persistOrder = async (next: AdminCategory[]) => {
    const previous = items;
    setItems(next);
    setError(null);

    try {
      await api.post('/api/admin/categories/reorder', { ids: next.map((item) => item.id) });
      router.refresh();
    } catch (caught) {
      setItems(previous);
      setError(caught instanceof AdminApiError ? caught.message : 'The new order could not be saved.');
    }
  };

  const nudge = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const moved = next[index];
    const displaced = next[target];
    if (!moved || !displaced) return;
    next[index] = displaced;
    next[target] = moved;
    void persistOrder(next);
  };

  const onDrop = (targetId: string) => {
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null);
      setOverId(null);
      return;
    }

    const from = items.findIndex((item) => item.id === draggingId);
    const to = items.findIndex((item) => item.id === targetId);
    setDraggingId(null);
    setOverId(null);
    if (from === -1 || to === -1) return;

    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(to, 0, moved);
    void persistOrder(next);
  };

  const remove = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    const mode = deleteTarget ? 'reassign' : 'unassign';
    setPendingDelete(null);
    setBusy(true);
    setError(null);

    try {
      const params = new URLSearchParams({ mode });
      if (deleteTarget) params.set('target', deleteTarget);
      const result = await api.delete<{ movedAudio: number }>(
        `/api/admin/categories/${target.id}?${params.toString()}`,
      );

      setItems((current) => current.filter((item) => item.id !== target.id));
      setNotice(
        result.movedAudio === 0
          ? `Deleted “${target.name}”.`
          : `Deleted “${target.name}”. ${result.movedAudio} ${result.movedAudio === 1 ? 'track was' : 'tracks were'} ${
              mode === 'reassign' ? 'moved' : 'left uncategorised'
            }.`,
      );
      setDeleteTarget('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'That category could not be deleted.');
    } finally {
      setBusy(false);
    }
  };

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

      <div className="admin__toolbar" style={{ marginBottom: 0 }}>
        <p className="table__sub">
          {items.length} {items.length === 1 ? 'category' : 'categories'}
        </p>
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          New category
        </button>
      </div>

      {items.length === 0 ? (
        <div className="state">
          <span className="state__glyph" aria-hidden="true">
            ✦
          </span>
          <p className="state__title">No categories yet</p>
          <p className="state__body">
            Create the first one — “Tamil OGs”, “Ringtones”, whatever fits the library.
          </p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setCreating(true)}
            style={{ marginTop: 'var(--s-3)' }}
          >
            New category
          </button>
        </div>
      ) : (
        <ul className="sortable">
          {items.map((category, index) => (
            <li
              key={category.id}
              className="sortable__item"
              data-dragging={draggingId === category.id}
              data-over={overId === category.id && draggingId !== category.id}
              draggable
              onDragStart={() => setDraggingId(category.id)}
              onDragEnd={() => {
                setDraggingId(null);
                setOverId(null);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setOverId(category.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                onDrop(category.id);
              }}
            >
              <span className="sortable__grip" aria-hidden="true">
                ⠿
              </span>

              <div className="sortable__order">
                <button
                  type="button"
                  onClick={() => nudge(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move ${category.name} up`}
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => nudge(index, 1)}
                  disabled={index === items.length - 1}
                  aria-label={`Move ${category.name} down`}
                >
                  ▼
                </button>
              </div>

              <div className="sortable__body">
                <p className="sortable__name">
                  {category.icon ? <span aria-hidden="true">{category.icon} </span> : null}
                  {category.name}
                </p>
                <p className="sortable__meta">
                  /category/{category.slug} · {category.audioCount}{' '}
                  {category.audioCount === 1 ? 'track' : 'tracks'}
                </p>
              </div>

              <span className={`badge ${category.isPublished ? 'badge--live' : 'badge--draft'}`}>
                {category.isPublished ? 'Live' : 'Hidden'}
              </span>

              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setEditing(category)}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn--danger btn--sm"
                onClick={() => {
                  setPendingDelete(category);
                  setDeleteTarget('');
                }}
                disabled={busy}
              >
                {busy ? <SpinnerIcon size={14} /> : 'Delete'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating || editing ? (
        <CategoryDialog
          category={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(saved, isNew) => {
            setItems((current) =>
              isNew
                ? [...current, saved]
                : current.map((item) => (item.id === saved.id ? saved : item)),
            );
            setCreating(false);
            setEditing(null);
            setNotice(isNew ? `Created “${saved.name}”.` : `Saved “${saved.name}”.`);
            router.refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete “${pendingDelete?.name ?? ''}”?`}
        body={
          pendingDelete && pendingDelete.audioCount > 0
            ? `${pendingDelete.audioCount} ${pendingDelete.audioCount === 1 ? 'track is' : 'tracks are'} in this category. Choose what happens to them — no track is ever deleted with a category.`
            : 'This category is empty, so nothing else is affected.'
        }
        confirmLabel="Delete category"
        destructive
        onConfirm={() => void remove()}
        onCancel={() => setPendingDelete(null)}
      >
        {pendingDelete && pendingDelete.audioCount > 0 ? (
          <div className="field">
            <label className="field__label" htmlFor="delete-target">
              Move its tracks to
            </label>
            <select
              id="delete-target"
              className="field__select"
              value={deleteTarget}
              onChange={(event) => setDeleteTarget(event.target.value)}
            >
              <option value="">Leave them uncategorised</option>
              {items
                .filter((item) => item.id !== pendingDelete.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** Create or edit one category. */
function CategoryDialog({
  category,
  onClose,
  onSaved,
}: {
  category: AdminCategory | null;
  onClose: () => void;
  onSaved: (category: AdminCategory, isNew: boolean) => void;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [slug, setSlug] = useState(category?.slug ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const [icon, setIcon] = useState(category?.icon ?? '');
  const [accent, setAccent] = useState(category?.accent ?? '#ff8a3d');
  const [isPublished, setIsPublished] = useState(category?.isPublished ?? true);
  const [isFeatured, setIsFeatured] = useState(category?.isFeatured ?? false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const save = async () => {
    setSaving(true);
    setError(null);
    setFieldErrors({});

    const payload = {
      name: name.trim(),
      // An empty slug means "derive one from the name" on create; on edit it
      // means "leave the address alone".
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      description: description.trim(),
      icon: icon.trim(),
      accent,
      isPublished,
      isFeatured,
    };

    try {
      const result = category
        ? await api.patch<{ category: AdminCategory }>(
            `/api/admin/categories/${category.id}`,
            payload,
          )
        : await api.post<{ category: AdminCategory }>('/api/admin/categories', payload);

      onSaved(result.category, category === null);
    } catch (caught) {
      if (caught instanceof AdminApiError) {
        setError(caught.message);
        if (caught.details) setFieldErrors(caught.details);
      } else {
        setError('That category could not be saved.');
      }
      setSaving(false);
    }
  };

  return (
    <div
      className="modal"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal__panel" role="dialog" aria-modal="true" aria-labelledby="category-title">
        <h2 className="modal__title" id="category-title">
          {category ? 'Edit category' : 'New category'}
        </h2>

        {error ? (
          <p className="banner banner--error" role="alert" style={{ marginTop: 'var(--s-4)' }}>
            {error}
          </p>
        ) : null}

        <div className="stack" style={{ marginTop: 'var(--s-5)' }}>
          <div className="field">
            <label className="field__label" htmlFor="cat-name">
              Name
            </label>
            <input
              id="cat-name"
              className="field__input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Tamil OGs"
              aria-invalid={Boolean(fieldErrors.name)}
              autoFocus
              required
            />
            {fieldErrors.name ? <p className="field__error">{fieldErrors.name[0]}</p> : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="cat-slug">
              Address
            </label>
            <input
              id="cat-slug"
              className="field__input"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="tamil-ogs"
              spellCheck={false}
              aria-invalid={Boolean(fieldErrors.slug)}
            />
            <p className="field__hint">
              {slug.trim()
                ? `/category/${slug.trim()}`
                : 'Leave blank and one is made from the name.'}
            </p>
            {fieldErrors.slug ? <p className="field__error">{fieldErrors.slug[0]}</p> : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="cat-description">
              Description
            </label>
            <textarea
              id="cat-description"
              className="field__textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
            />
          </div>

          <div style={{ display: 'flex', gap: 'var(--s-3)' }}>
            <div className="field" style={{ flex: 1 }}>
              <label className="field__label" htmlFor="cat-icon">
                Icon
              </label>
              <input
                id="cat-icon"
                className="field__input"
                value={icon}
                onChange={(event) => setIcon(event.target.value)}
                placeholder="🔥"
                maxLength={8}
              />
            </div>

            <div className="field" style={{ width: '8rem' }}>
              <label className="field__label" htmlFor="cat-accent">
                Accent
              </label>
              <input
                id="cat-accent"
                className="field__input"
                type="color"
                value={accent}
                onChange={(event) => setAccent(event.target.value)}
                style={{ padding: '0.25rem' }}
              />
            </div>
          </div>

          <label className="switch">
            <input
              type="checkbox"
              checked={isPublished}
              onChange={(event) => setIsPublished(event.target.checked)}
            />
            Visible on the site
          </label>

          <label className="switch">
            <input
              type="checkbox"
              checked={isFeatured}
              onChange={(event) => setIsFeatured(event.target.checked)}
            />
            Feature on the homepage
          </label>
        </div>

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void save()}
            disabled={saving || name.trim().length === 0}
          >
            {saving ? <SpinnerIcon size={16} /> : null}
            {saving ? 'Saving…' : category ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
