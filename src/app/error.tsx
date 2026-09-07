'use client';

import { useEffect } from 'react';

/**
 * The public error boundary.
 *
 * A visitor gets one plain sentence and a retry — never a stack trace, never an
 * error code they cannot act on. React already logs the real error to the
 * server console in production, which is where the detail belongs.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only handle that ties this page to a server log line.
    console.error('Unhandled UI error', error.digest ?? error.message);
  }, [error]);

  return (
    <div className="page page--narrow">
      <div className="state">
        <span className="state__glyph" aria-hidden="true">
          ⚠
        </span>
        <h1 className="state__title">Something went wrong</h1>
        <p className="state__body">
          That is on us, not you. Try again — if it keeps happening, come back in a few minutes.
        </p>
        <button type="button" className="btn btn--primary" onClick={reset} style={{ marginTop: 'var(--s-4)' }}>
          Try again
        </button>
      </div>
    </div>
  );
}
