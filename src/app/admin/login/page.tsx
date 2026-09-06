import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/admin/LoginForm';
import { getCurrentSession } from '@/lib/auth/session';
import { ensurePragmas } from '@/lib/db';

/** The one unauthenticated admin page. */
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  await ensurePragmas();
  const session = await getCurrentSession();
  if (session) redirect('/admin');

  return (
    <div className="admin__auth">
      <div className="admin__auth-card">
        <span className="wordmark__mark" aria-hidden="true">
          M
        </span>
        <h1 className="admin__auth-title">Sign in</h1>
        <p className="admin__auth-sub">This area is for the owner of the library.</p>
        <LoginForm />
      </div>
    </div>
  );
}
