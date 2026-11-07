import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '@/stores/workspace-store';
import type { MockupReference } from '@/lib/mockups';
export function MockupCard({
  reference,
  threadId,
}: {
  reference: MockupReference;
  threadId: string;
}) {
  const { t } = useTranslation('mockups');
  // Tool history copied from another conversation must not activate a foreign view.
  if (reference.threadId !== threadId) return null;
  return (
    <section className="flex items-center gap-4 rounded-lg border bg-card p-4">
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium">{reference.title}</p>
        <p className="text-xs text-muted-foreground">
          {t('title')} · v{reference.number}
        </p>
      </div>
      <button
        type="button"
        className="rounded border px-3 py-2 text-sm"
        onClick={() =>
          useWorkspaceStore
            .getState()
            .openMockup(`thread:${threadId}`, reference)
        }
      >
        {t('open')}
      </button>
    </section>
  );
}
