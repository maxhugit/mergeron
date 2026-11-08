import { useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { projectsApi, type ProjectTaskSummary } from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';
import { Button } from '@/components/ui/button';

type Change = { value: number; updatedAt: number };
export function SubtaskProgressEditor({
  projectId,
  task,
  children,
}: {
  projectId: string;
  task: Pick<ProjectTaskSummary, 'id' | 'title' | 'resourceId' | 'progress'> & {
    updatedAt?: number;
    subtaskStatus?: ProjectTaskSummary['subtaskStatus'];
  };
  children?: (value: number) => ReactNode;
}) {
  const { t } = useTranslation('workspaces');
  const session = usePlatformSession();
  const client = useQueryClient();
  const [draft, setDraft] = useState<Change | null>(null);
  const draftRef = useRef<Change | null>(null);
  const [confirmed, setConfirmed] = useState<Change | null>(null);
  const saving = useRef(false);
  const mutation = useMutation({
    mutationFn: (change: Change) =>
      projectsApi<{ task?: { progress: number; updatedAt: number } }>(
        `/${projectId}/resources/${task.resourceId}/tasks/${task.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            progress: change.value,
            expectedUpdatedAt: change.updatedAt,
          }),
        },
      ),
    onSuccess: async (result, change) => {
      setConfirmed({
        value: result.task?.progress ?? change.value,
        updatedAt: result.task?.updatedAt ?? change.updatedAt,
      });
      setDraft(null);
      draftRef.current = null;
      await Promise.all([
        client.invalidateQueries({ queryKey: ['project-resource', projectId] }),
        client.invalidateQueries({
          queryKey: ['project-deliverables', projectId],
        }),
        client.invalidateQueries({ queryKey: ['projects'] }),
      ]);
    },
    onSettled: () => {
      saving.current = false;
    },
  });
  const saved =
    confirmed && confirmed.updatedAt >= (task.updatedAt ?? 0)
      ? confirmed
      : { value: task.progress, updatedAt: task.updatedAt ?? 0 };
  const value = draft?.value ?? saved.value;
  const unavailable = !Number.isSafeInteger(task.updatedAt);
  const locked =
    task.subtaskStatus === 'done' || task.subtaskStatus === 'cancelled';
  const editable = session.isAdministrator && !locked && !unavailable;
  const commit = () => {
    const change = draftRef.current;
    if (!editable || saving.current || !change) return;
    if (change.value === saved.value) {
      draftRef.current = null;
      setDraft(null);
      return;
    }
    saving.current = true;
    mutation.mutate(change);
  };
  const change = (raw: string) => {
    if (!editable || saving.current) return;
    const number = Number(raw);
    if (!Number.isFinite(number)) return;
    const next = {
      value: Math.max(0, Math.min(100, Math.round(number))),
      updatedAt: draftRef.current?.updatedAt ?? saved.updatedAt,
    };
    mutation.reset();
    draftRef.current = next;
    setDraft(next);
  };
  return (
    <div>
      {children?.(value)}
      <div className="px-3 pb-2 pl-9">
        {session.isAdministrator ? (
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={value}
            disabled={!editable}
            aria-disabled={!editable || mutation.isPending}
            aria-label={t('sidebarProgressFor', { title: task.title })}
            title={
              locked
                ? t('sidebarProgressLocked')
                : unavailable
                  ? t('sidebarProgressUnavailable')
                  : t('sidebarProgressFor', { title: task.title })
            }
            className="agent-subtask-progress w-full focus-visible:outline-2 focus-visible:outline-ring"
            style={{ '--task-progress': `${value}%` } as CSSProperties}
            onChange={(event) => change(event.target.value)}
            onPointerUp={commit}
            onBlur={commit}
            onPointerCancel={() => {
              if (!saving.current) {
                draftRef.current = null;
                setDraft(null);
              }
            }}
            onKeyUp={(event) => {
              if (
                [
                  'ArrowLeft',
                  'ArrowRight',
                  'ArrowUp',
                  'ArrowDown',
                  'Home',
                  'End',
                  'PageUp',
                  'PageDown',
                ].includes(event.key)
              )
                commit();
            }}
          />
        ) : (
          <div
            className="h-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={t('sidebarProgressFor', { title: task.title })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={value}
          >
            <div
              className="h-full bg-violet-500"
              style={{ width: `${value}%` }}
            />
          </div>
        )}
        {mutation.isPending && (
          <p role="status" className="text-xs text-muted-foreground">
            {t('sidebarProgressSaving')}
          </p>
        )}
        {mutation.isError && (
          <div className="space-y-1">
            <p role="alert" className="text-xs text-destructive">
              {t('sidebarProgressError')}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={commit}>
                {t('sidebarProgressRetry')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await Promise.all([
                    client.invalidateQueries({
                      queryKey: ['project-resource', projectId],
                    }),
                    client.invalidateQueries({
                      queryKey: ['project-deliverables', projectId],
                    }),
                  ]);
                  setDraft(null);
                  draftRef.current = null;
                  setConfirmed(null);
                  mutation.reset();
                }}
              >
                {t('sidebarProgressReload')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
