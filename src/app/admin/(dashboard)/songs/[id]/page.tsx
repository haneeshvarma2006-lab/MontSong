import Link from 'next/link';
import { notFound } from 'next/navigation';

import { SongEditor } from '@/components/admin/SongEditor';
import { getAudio } from '@/lib/repositories/audio';
import { listCategories } from '@/lib/repositories/categories';
import { toAdminAudio, toAdminCategory } from '@/lib/serializers';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Edit song' };

export default async function EditSongPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [audio, categories] = await Promise.all([getAudio(id), listCategories({ withCounts: true })]);

  if (!audio) notFound();

  return (
    <div className="stack-lg">
      <div className="admin__toolbar">
        <div>
          <h1 className="admin__title">{audio.title}</h1>
          <p className="admin__subtitle">{audio.artist ?? 'No artist set'}</p>
        </div>
        <Link href="/admin/songs" className="btn btn--ghost">
          Back to songs
        </Link>
      </div>

      <SongEditor audio={toAdminAudio(audio)} categories={categories.map(toAdminCategory)} />
    </div>
  );
}
