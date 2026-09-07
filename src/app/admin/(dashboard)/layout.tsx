import { redirect } from 'next/navigation';

import { AdminNav } from '@/components/admin/AdminNav';
import { getCurrentSession } from '@/lib/auth/session';
import { ensurePragmas } from '@/lib/db';

/**
 * The signed-in area.
 *
 * The session is verified here, on the server, before any admin markup is
 * produced — so an unauthenticated visitor never receives the page, not even to
 * have it hidden by client code. Every route under `/api/admin` repeats the
 * check for itself, because a rendered page is not what authorises a request.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await ensurePragmas();
  const session = await getCurrentSession();

  if (!session) redirect('/admin/login');

  return (
    <>
      <AdminNav username={session.user.username} />
      <div className="admin__body">{children}</div>
    </>
  );
}
