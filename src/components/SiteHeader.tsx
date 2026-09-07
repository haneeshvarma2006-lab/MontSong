'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * The header.
 *
 * Sticky and translucent, gaining a hairline only once the page has scrolled —
 * so it reads as part of the page at rest and as a distinct layer in motion.
 * The scroll listener is passive and only ever flips one boolean, so it cannot
 * become a scroll-jank source.
 */
export function SiteHeader({ siteName }: { siteName: string }) {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // The admin area has its own chrome.
  if (pathname?.startsWith('/admin')) return null;

  const initial = siteName.trim().charAt(0).toUpperCase() || 'M';

  return (
    <header className={`header${scrolled ? ' header--scrolled' : ''}`}>
      <div className="page header__inner">
        <Link href="/" className="wordmark" aria-label={`${siteName} home`}>
          <span className="wordmark__mark" aria-hidden="true">
            {initial}
          </span>
          {siteName}
        </Link>

        <nav className="nav" aria-label="Primary">
          <Link
            href="/"
            className="nav__link"
            aria-current={pathname === '/' ? 'page' : undefined}
          >
            Library
          </Link>
          <Link
            href="/search"
            className="nav__link"
            aria-current={pathname === '/search' ? 'page' : undefined}
          >
            Search
          </Link>
        </nav>
      </div>
    </header>
  );
}
