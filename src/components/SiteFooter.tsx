'use client';

import { usePathname } from 'next/navigation';

/**
 * The public footer.
 *
 * A client component for one reason: the admin area has its own chrome, and
 * public-site copy has no business appearing under a sign-in form. Matching
 * SiteHeader, it removes itself on any admin route.
 */
export function SiteFooter({ siteName, about }: { siteName: string; about: string }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/admin')) return null;

  return (
    <footer className="footer">
      <div className="page footer__inner">
        <p>
          {siteName} · {about}
        </p>
        <p>Made for listening.</p>
      </div>
    </footer>
  );
}
