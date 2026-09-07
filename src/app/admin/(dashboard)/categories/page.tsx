import { CategoryManager } from '@/components/admin/CategoryManager';
import { listCategories } from '@/lib/repositories/categories';
import { toAdminCategory } from '@/lib/serializers';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Categories' };

/**
 * Category management.
 *
 * Nothing here is seeded or hardcoded — the list is whatever the owner has
 * made, and the public site reflects it immediately.
 */
export default async function CategoriesPage() {
  const categories = await listCategories({ withCounts: true });

  return (
    <div className="stack-lg">
      <div>
        <h1 className="admin__title">Categories</h1>
        <p className="admin__subtitle">
          Create them, rename them, drag to reorder. The site follows this order.
        </p>
      </div>

      <CategoryManager initial={categories.map(toAdminCategory)} />
    </div>
  );
}
