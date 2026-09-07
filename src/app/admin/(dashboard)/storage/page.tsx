import { StoragePanel } from '@/components/admin/StoragePanel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Storage' };

/**
 * Storage diagnostics.
 *
 * Rendered as a client panel because everything on it is live state that the
 * owner will want to re-check without a page reload — a connection test, cache
 * occupancy, and any upload that needs reconciling.
 */
export default function StoragePage() {
  return (
    <div className="stack-lg">
      <div>
        <h1 className="admin__title">Storage</h1>
        <p className="admin__subtitle">
          Where the files live, how much is cached, and anything that needs attention.
        </p>
      </div>

      <StoragePanel />
    </div>
  );
}
