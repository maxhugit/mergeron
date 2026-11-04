import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { projectsApi, type ProjectTaskSummary } from '@/lib/projects-api';
import type { Deliverable } from '@/lib/deliverables-api';
export function TaskDeliverableLink({
  projectId,
  resourceId,
  task,
  deliverables,
  onClose,
}: {
  projectId: string;
  resourceId: string;
  task: ProjectTaskSummary;
  deliverables: Deliverable[];
  onClose: () => void;
}) {
  const { t } = useTranslation('deliverables'),
    client = useQueryClient();
  const [mode, setMode] = useState<'existing' | 'new'>('existing'),
    [selected, setSelected] = useState(''),
    [title, setTitle] = useState(task.title);
  const available = deliverables.filter(
    (d) =>
      !d.primaryTaskId &&
      ['draft', 'in_constitution'].includes(d.lifecycleStatus),
  );
  const mutation = useMutation({
    mutationFn: () =>
      projectsApi(
        `/${projectId}/resources/${resourceId}/deliverables/link-task`,
        {
          method: 'POST',
          body: JSON.stringify({
            taskId: task.id,
            expectedTaskUpdatedAt: task.updatedAt,
            ...(mode === 'new'
              ? { title }
              : {
                  deliverableId: selected,
                  expectedVersion: available.find((d) => d.id === selected)
                    ?.version,
                }),
          }),
        },
      ),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: ['project-deliverables', projectId],
        }),
        client.invalidateQueries({ queryKey: ['project-resource', projectId] }),
      ]);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !mutation.isPending && onClose()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('taskLinkDeliverable')}</DialogTitle>
          <DialogDescription>{task.title}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={mode === 'existing' ? 'default' : 'outline'}
            disabled={mutation.isPending}
            onClick={() => setMode('existing')}
          >
            {t('taskChooseExisting')}
          </Button>
          <Button
            variant={mode === 'new' ? 'default' : 'outline'}
            disabled={mutation.isPending}
            onClick={() => setMode('new')}
          >
            {t('taskCreateDeliverable')}
          </Button>
        </div>
        {mode === 'existing' ? (
          <label className="grid gap-2 text-sm">
            {t('taskAvailableDeliverables')}
            <select
              className="rounded-md border bg-background p-2"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={mutation.isPending}
            >
              <option value="">{t('taskSelectDeliverable')}</option>
              {available.map((d) => (
                <option value={d.id} key={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
            {!available.length && (
              <span className="text-xs text-muted-foreground">
                {t('taskNoAvailableDeliverables')}
              </span>
            )}
          </label>
        ) : (
          <label className="grid gap-2 text-sm">
            {t('taskDeliverableTitle')}
            <Input
              value={title}
              maxLength={160}
              disabled={mutation.isPending}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        )}
        {mutation.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('taskLinkFailed')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            {t('labelsCancel')}
          </Button>
          <Button
            disabled={
              mutation.isPending || (mode === 'new' ? !title.trim() : !selected)
            }
            onClick={() => mutation.mutate()}
          >
            {mode === 'new' ? t('taskCreateAndLink') : t('taskLink')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
