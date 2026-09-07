import type { Metadata } from 'next';

/**
 * Admin shell.
 *
 * Deliberately shallow: it only sets metadata. The authorisation check lives in
 * the (dashboard) layout below it, so /admin/login can render without one — and
 * every admin API route enforces the same check independently, so this is a
 * convenience for the owner rather than the security boundary.
 */
export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin' },
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="admin">{children}</div>;
}
