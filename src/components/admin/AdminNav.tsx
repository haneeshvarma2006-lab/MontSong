'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

import { api } from './api';

const LINKS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/songs', label: 'Songs' },
  { href: '/admin/categories', label: 'Categories' },
  { href: '/admin/storage', label: 'Storage' },
] as const;

/** Admin chrome: navigation plus sign-out. */
export function AdminNav({ username }: { username: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await api.post('/api/admin/auth/logout');
    } finally {
      // Whatever the server said, stop showing admin UI.
      router.replace('/admin/login');
      router.refresh();
    }
  };

  return (
    <header className="admin__header">
      <div className="admin__header-inner">
        <div className="admin__brand">
          <Link href="/" className="wordmark">
            <span className="wordmark__mark" aria-hidden="true">
              M
            </span>
            Admin
          </Link>
        </div>

        <nav className="admin__nav" aria-label="Admin sections">
          {LINKS.map((link) => {
            const active =
              link.href === '/admin' ? pathname === '/admin' : pathname?.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className="admin__nav-link"
                aria-current={active ? 'page' : undefined}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="admin__account">
          <span className="admin__user">{username}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void signOut()}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>
    </header>
  );
}
