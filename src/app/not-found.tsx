import Link from 'next/link';

/** 404. Calm, useful, and it offers the one thing that helps: a way back. */
export default function NotFound() {
  return (
    <div className="page page--narrow">
      <div className="state">
        <span className="state__glyph" aria-hidden="true">
          ⌕
        </span>
        <h1 className="state__title">We could not find that</h1>
        <p className="state__body">
          The page you were looking for has moved, or the track is no longer published.
        </p>
        <Link href="/" className="btn btn--primary" style={{ marginTop: 'var(--s-4)' }}>
          Back to the library
        </Link>
      </div>
    </div>
  );
}
