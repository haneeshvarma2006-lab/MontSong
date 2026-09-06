import Link from 'next/link';

import { SongsTable } from '@/components/admin/SongsTable';
import { listCategories } from '@/lib/repositories/categories';
import { toAdminCategory } from '@/lib/serializers';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Songs' };

/**
 * The songs screen. Categories are fetched on the server and handed to the
 * table so its per-row category selector is populated on first paint.
 */
export default async function SongsPage() {
  const categories = await listCategories({ withCounts: true });

  return (
    <div className="stack-lg">
      <div className="admin__toolbar">
        <div>
          <h1 className="admin__title">Songs</h1>
          <p className="admin__subtitle">Everything in the library, published or not.</p>
        </div>
        <Link href="/admin/songs/new" className="btn btn--primary">
          Add a song
        </Link>
      </div>

      <SongsTable categories={categories.map(toAdminCategory)} />
    </div>
  );
}
