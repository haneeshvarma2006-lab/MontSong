'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { CloseIcon, SearchIcon, SpinnerIcon } from '@/components/icons';
import type { PublicAudio } from '@/lib/serializers';

/**
 * Search with live suggestions.
 *
 * Behaviour worth being deliberate about:
 *
 *  - **Debounced at 220 ms**, which is under the threshold where typing starts
 *    to feel laggy and well above per-keystroke request spam.
 *  - **Every request is abortable.** A slower earlier response can otherwise
 *    land after a faster later one and overwrite it with stale results.
 *  - **Combobox semantics.** Arrow keys move through suggestions, Enter opens
 *    the highlighted one (or runs a full search), Escape closes. The listbox is
 *    wired with `aria-activedescendant`, so a screen reader announces the
 *    highlighted option without moving focus out of the input.
 */

const DEBOUNCE_MS = 220;

export function SearchBox({
  autoFocus = false,
  placeholder = 'Search songs, ringtones, artists…',
}: {
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const router = useRouter();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  /**
   * The last completed lookup, tagged with the query it answered.
   *
   * Keeping the query alongside its results makes "are we still waiting?" a
   * derived value rather than a second piece of state to keep in sync — which
   * is what stops a stale response from ever being shown as current.
   */
  const [loaded, setLoaded] = useState<{ query: string; results: PublicAudio[] }>({
    query: '',
    results: [],
  });
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const trimmedQuery = query.trim();
  const results = loaded.query === trimmedQuery ? loaded.results : [];
  const loading = trimmedQuery.length > 0 && loaded.query !== trimmedQuery;

  /**
   * Clearing the box is a user action, not a synchronisation problem, so it is
   * handled in the change handler. Doing it in an effect would mean a render
   * with stale suggestions followed immediately by a second render clearing
   * them.
   */
  const updateQuery = (value: string) => {
    setQuery(value);
    if (value.trim().length === 0) {
      abortRef.current?.abort();
      setLoaded({ query: '', results: [] });
      setOpen(false);
      setHighlight(-1);
    }
  };

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;

    const timer = window.setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=6`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as { results: PublicAudio[] };
        setLoaded({ query: trimmed, results: data.results });
        setOpen(true);
        setHighlight(-1);
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        // A failed suggestion lookup is not worth an error banner — the full
        // search page still works, and the user is mid-thought.
        setLoaded({ query: trimmed, results: [] });
        setOpen(true);
      }
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query]);

  // Close when focus or a click leaves the widget.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const goToSearch = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      setOpen(false);
      router.push(`/search?q=${encodeURIComponent(trimmed)}`);
    },
    [router],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (results.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
        if (next < 0) return results.length - 1;
        if (next >= results.length) return 0;
        return next;
      });
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = highlight >= 0 ? results[highlight] : undefined;
      if (selected) {
        setOpen(false);
        router.push(`/song/${selected.slug}`);
      } else {
        goToSearch(query);
      }
    }
  };

  return (
    <div className="search" ref={rootRef}>
      <div className="search__field">
        <SearchIcon className="search__icon" size={18} />
        <input
          ref={inputRef}
          className="search__input"
          type="search"
          value={query}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={highlight >= 0 ? `${listboxId}-${highlight}` : undefined}
          aria-label="Search the library"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
        />
        {loading ? (
          <SpinnerIcon size={16} className="search__icon" />
        ) : query.length > 0 ? (
          <button
            type="button"
            className="search__clear"
            onClick={() => {
              updateQuery('');
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
          >
            <CloseIcon size={16} />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="search__results" id={listboxId} role="listbox" aria-label="Suggestions">
          {results.length === 0 ? (
            <p className="search__empty">No matches for “{query.trim()}”.</p>
          ) : (
            <>
              {results.map((track, index) => (
                <button
                  key={track.id}
                  id={`${listboxId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={highlight === index}
                  data-active={highlight === index}
                  className="search__result"
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => {
                    setOpen(false);
                    router.push(`/song/${track.slug}`);
                  }}
                >
                  <span>
                    <span className="search__result-title">{track.title}</span>
                    <span className="search__result-meta">
                      {[track.artist, track.category?.name].filter(Boolean).join(' · ') ||
                        track.format}
                    </span>
                  </span>
                </button>
              ))}
              <button type="button" className="search__result" onClick={() => goToSearch(query)}>
                <span className="search__result-meta">
                  See all results for “{query.trim()}”
                </span>
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
