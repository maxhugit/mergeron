import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { projectsApi, type ProjectTaskSummary } from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';

/** The observed revision is captured when editing starts, never at save time. */
export function SubtaskProgressEditor({
  projectId,
  task,
}: {
  projectId: string;
  task: Pick<ProjectTaskSummary, 'id' | 'title' | 'resourceId' | 'progress'> & {
    updatedAt?: number;
    subtaskStatus?: ProjectTaskSummary['subtaskStatus'];
  };
}) {
  const { t } = useTranslation('workspaces');
  const session = usePlatformSession();
  const client = useQueryClient();
  const [draft, setDraft] = useState<{
    value: number;
    updatedAt: number;
  } | null>(null);
  const mutation = useMutation({
    mutationFn: async (change: { value: number; updatedAt: number }) => {
      await projectsApi(
        `/${projectId}/resources/${task.resourceId}/tasks/${task.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            progress: change.value,
            expectedUpdatedAt: change.updatedAt,
          }),
        },
      );
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['project-resource', projectId] }),
        client.invalidateQueries({
          queryKey: ['project-deliverables', projectId],
        }),
        client.invalidateQueries({ queryKey: ['projects'] }),
      ]);
      setDraft(null);
    },
  });
  if (!session.isAdministrator) return null;
  const value = draft?.value ?? task.progress;
  const unavailable = !Number.isSafeInteger(task.updatedAt);
  const locked =
    task.subtaskStatus === 'done' || task.subtaskStatus === 'cancelled';
  const change = (raw: string) => {
    const number = Number(raw);
    if (!Number.isFinite(number) || unavailable) return;
    mutation.reset();
    setDraft({
      value: Math.max(0, Math.min(100, Math.round(number))),
      updatedAt: draft?.updatedAt ?? task.updatedAt!,
    });
  };
  return (
    <div
      className="space-y-2 px-3 pb-3"
      role="group"
      aria-label={t('sidebarProgressFor', { title: task.title })}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span>{t('sidebarProgress')}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          disabled={locked || unavailable || mutation.isPending}
          onChange={(event) => change(event.target.value)}
          className="min-w-0 flex-1 accent-violet-600"
          aria-label={t('sidebarProgressFor', { title: task.title })}
        />
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={value}
          disabled={locked || unavailable || mutation.isPending}
          onChange={(event) => change(event.target.value)}
          className="w-14 rounded border bg-background px-1 py-1 text-right tabular-nums"
          aria-label={t('sidebarProgressPercent', { title: task.title })}
        />
        <span>%</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          {t(
            unavailable
              ? 'sidebarProgressUnavailable'
              : locked
                ? 'sidebarProgressLocked'
                : 'sidebarProgressStatusNote',
          )}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={
            locked ||
            unavailable ||
            !draft ||
            draft.value === task.progress ||
            mutation.isPending
          }
          onClick={() => draft && mutation.mutate(draft)}
        >
          {t('sidebarSaveProgress')}
        </Button>
      </div>
      {mutation.isError && (
        <p role="alert" className="text-xs text-destructive">
          {t('sidebarProgressError')}
        </p>
      )}
    </div>
  );
}
