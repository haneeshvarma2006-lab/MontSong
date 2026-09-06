/**
 * Route-level loading state.
 *
 * Shaped like the content it replaces — a title block and a list of rows — so
 * the page does not visibly reflow when the real content arrives.
 */
export default function Loading() {
  return (
    <div className="page" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading…</span>

      <div className="hero">
        <div className="skeleton" style={{ height: '3rem', width: 'min(18rem, 70%)' }} />
        <div className="skeleton" style={{ height: '1.25rem', width: 'min(26rem, 90%)', marginTop: 'var(--s-4)' }} />
        <div className="skeleton" style={{ height: '3rem', width: 'min(30rem, 100%)', marginTop: 'var(--s-8)', borderRadius: 'var(--r-full)' }} />
      </div>

      <div className="section">
        <div className="categories">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="skeleton" style={{ height: '7.5rem', borderRadius: 'var(--r-lg)' }} />
          ))}
        </div>
      </div>

      <div className="section stack">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="skeleton" style={{ height: '3.5rem' }} />
        ))}
      </div>
    </div>
  );
}
