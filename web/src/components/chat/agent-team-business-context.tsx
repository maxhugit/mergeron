import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  readTeamContext,
  saveTeamLinks,
  createTaskFromContribution,
  type AgentTeamDetail,
} from '@/lib/agent-teams-api';
import { getApiErrorMessage } from '@/lib/api-error';
export function AgentTeamBusinessContext({
  projectId,
  team,
  assignmentId,
  active,
  onChanged,
  onDirtyChange,
}: {
  projectId: string;
  team: AgentTeamDetail;
  assignmentId: string;
  active: boolean;
  onChanged: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation('teams');
  const context = useQuery({
    queryKey: ['agent-team-context', projectId, team.coordinatorThreadId],
    queryFn: ({ signal }) =>
      readTeamContext(projectId, team.coordinatorThreadId, signal),
    enabled: active,
  });
  const [edited, setEdited] = useState<{
    deliverableId: string | null;
    assignments: Array<{ id: string; taskId: string | null }>;
  } | null>(null);
  const [proposal, setProposal] = useState(false),
    [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [board, setBoard] = useState('');
  const links = edited ?? {
    deliverableId: team.deliverableId,
    assignments: team.assignments.map((a) => ({ id: a.id, taskId: a.taskId })),
  };
  const selected = team.assignments.find((a) => a.id === assignmentId);
  const save = useMutation({
    mutationFn: () => saveTeamLinks(projectId, team.id, links),
    retry: false,
    onSuccess: () => {
      setEdited(null);
      onChanged();
    },
  });
  const create = useMutation({
    mutationFn: () =>
      createTaskFromContribution(projectId, team.id, assignmentId, {
        confirmed: true,
        resourceId: board,
        title,
        description,
      }),
    retry: false,
    onSuccess: () => {
      setProposal(false);
      onChanged();
    },
  });
  useEffect(() => {
    onDirtyChange(!!edited || save.isPending);
  }, [edited, save.isPending, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const canEdit = team.canRespond && team.state === 'draft';
  const data = context.isError ? undefined : context.data;
  if (context.isError)
    return (
      <p role="alert" className="break-words text-destructive">
        {getApiErrorMessage(context.error)}
      </p>
    );
  return (
    <section
      className="space-y-3 border-t pt-3"
      aria-label={t('businessLinks')}
    >
      <h3 className="font-medium">{t('businessLinks')}</h3>
      {context.isPending && <p role="status">{t('loading')}</p>}
      {data?.truncated && <p className="text-xs">{t('catalogLimited')}</p>}
      {canEdit && data ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t('publicContextOnly')}
          </p>
          <label className="block space-y-1">
            <span>{t('linkedDeliverable')}</span>
            <select
              className="h-10 w-full min-w-0 rounded-md border bg-background px-2"
              disabled={save.isPending}
              value={links.deliverableId ?? ''}
              onChange={(e) =>
                setEdited({ ...links, deliverableId: e.target.value || null })
              }
            >
              <option value="">{t('noBusinessLink')}</option>
              {data.deliverables.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
          {team.assignments.map((assignment) => (
            <label key={assignment.id} className="block space-y-1">
              <span>{t('linkedRoleTask', { role: assignment.role })}</span>
              <select
                className="h-10 w-full min-w-0 rounded-md border bg-background px-2"
                disabled={save.isPending}
                value={
                  links.assignments.find((a) => a.id === assignment.id)
                    ?.taskId ?? ''
                }
                onChange={(e) =>
                  setEdited({
                    ...links,
                    assignments: links.assignments.map((a) =>
                      a.id === assignment.id
                        ? { ...a, taskId: e.target.value || null }
                        : a,
                    ),
                  })
                }
              >
                <option value="">{t('noBusinessLink')}</option>
                {data.tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={save.isPending || !edited}
            onClick={() => save.mutate()}
          >
            {t('saveLinks')}
          </Button>
          {save.isError && (
            <p role="alert" className="break-words text-destructive">
              {getApiErrorMessage(save.error)}
            </p>
          )}
          {save.isSuccess && <p role="status">{t('linksSaved')}</p>}
        </>
      ) : (
        <div className="space-y-1 text-xs text-muted-foreground">
          {team.deliverableId && (
            <p>
              {t('linkedDeliverable')}:{' '}
              {data?.deliverables.find((d) => d.id === team.deliverableId)
                ?.title ?? t('targetUnavailable')}
            </p>
          )}
          {selected?.taskId && (
            <p>
              {t('linkedRoleTask', { role: selected.role })}:{' '}
              {data?.tasks.find((task) => task.id === selected.taskId)?.title ??
                t('targetUnavailable')}
            </p>
          )}
          {!team.deliverableId && !selected?.taskId && (
            <p>{t('noBusinessLink')}</p>
          )}
        </div>
      )}
      {team.canRespond &&
        selected?.result &&
        ['completed', 'failed', 'cancelled'].includes(selected.status) &&
        !selected.taskId &&
        !!data?.boards.length && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setTitle(`${selected.role} — ${team.objective}`.slice(0, 200));
              setDescription(selected.result?.slice(0, 10000) ?? '');
              setBoard(data.boards[0].id);
              create.reset();
              setProposal(true);
            }}
          >
            {t('proposeTask')}
          </Button>
        )}
      <Dialog
        open={proposal}
        onOpenChange={(value) => {
          if (!create.isPending) setProposal(value);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('proposeTask')}</DialogTitle>
            <DialogDescription>{t('manualTaskDescription')}</DialogDescription>
          </DialogHeader>
          <label className="block space-y-1">
            <span>{t('taskBoard')}</span>
            <select
              className="h-10 w-full rounded-md border bg-background px-2"
              disabled={create.isPending}
              value={board}
              onChange={(e) => setBoard(e.target.value)}
            >
              {data?.boards.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span>{t('taskTitle')}</span>
            <Input
              disabled={create.isPending}
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span>{t('taskDescription')}</span>
            <Textarea
              className="min-h-36"
              disabled={create.isPending}
              maxLength={10000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {create.isError && (
            <p role="alert" className="break-words text-destructive">
              {getApiErrorMessage(create.error)}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={create.isPending}
              onClick={() => setProposal(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              disabled={create.isPending || !title.trim() || !board}
              onClick={() => create.mutate()}
            >
              {t('confirmTask')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
