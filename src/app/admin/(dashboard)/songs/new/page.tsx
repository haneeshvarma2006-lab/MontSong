import Link from 'next/link';

import { UploadForm } from '@/components/admin/UploadForm';
import { getConfig } from '@/lib/env';
import { formatBytes } from '@/lib/format';
import { listCategories } from '@/lib/repositories/categories';
import { toAdminCategory } from '@/lib/serializers';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Add a song' };

export default async function NewSongPage() {
  const [categories, config] = await Promise.all([
    listCategories({ withCounts: true }),
    Promise.resolve(getConfig()),
  ]);

  const usingCloud = config.telegram.apiBaseUrl === 'https://api.telegram.org';

  return (
    <div className="stack-lg">
      <div className="admin__toolbar">
        <div>
          <h1 className="admin__title">Add a song</h1>
          <p className="admin__subtitle">
            Up to {formatBytes(config.uploads.maxAudioBytes)} per file.
            {usingCloud
              ? ' That ceiling comes from the storage service — see Storage for how to raise it.'
              : ''}
          </p>
        </div>
        <Link href="/admin/songs" className="btn btn--ghost">
          Back to songs
        </Link>
      </div>

      <UploadForm
        categories={categories.map(toAdminCategory)}
        maxAudioBytes={config.uploads.maxAudioBytes}
      />
    </div>
  );
}
