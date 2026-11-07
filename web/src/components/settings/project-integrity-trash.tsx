import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  integrityRequest,
  type IntegrityIssue,
  type IntegrityReport,
} from './project-integrity-api';
const trashKey = (projectId: string) => ['project-integrity-trash', projectId];

export function IntegrityTrashAction({
  report,
  issue,
  disabled = false,
}: {
  report: IntegrityReport;
  issue: IntegrityIssue;
  disabled?: boolean;
}) {
  const { t } = useTranslation('integrity');
  const client = useQueryClient();
  const [plan, setPlan] = useState<{
      fingerprint: string;
      name: string;
      projectId: string;
      issueId: string;
      path: string;
    } | null>(null),
    [name, setName] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      integrityRequest<IntegrityReport>(
        '/' + encodeURIComponent(plan!.projectId) + '/trash',
        {
          fingerprint: plan!.fingerprint,
          issueId: plan!.issueId,
          name,
          confirmation: 'MOVE_TO_PROJECT_TRASH',
        },
      ),
    onSuccess: (next) => {
      client.setQueryData(['project-integrity', next.projectId], next);
      setPlan(null);
      void client.invalidateQueries({ queryKey: trashKey(report.projectId) });
    },
    onError: () => {
      void client.invalidateQueries({
        queryKey: ['project-integrity', report.projectId],
      });
      void client.invalidateQueries({ queryKey: trashKey(report.projectId) });
    },
  });
  if (!issue.trash || report.limited) return null;
  return (
    <>
      <Button
        variant="outline"
        className="h-auto justify-start whitespace-normal border-destructive/40 text-destructive"
        disabled={disabled || mutation.isPending}
        onClick={() => {
          mutation.reset();
          setName('');
          setPlan({
            fingerprint: report.fingerprint,
            name: issue.trash!.name,
            projectId: report.projectId,
            issueId: issue.id,
            path: issue.path,
          });
        }}
      >
        <Trash2 className="h-4 w-4 shrink-0" />
        {t('trash.move')}
      </Button>
      <AlertDialog
        open={!!plan}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setPlan(null);
        }}
      >
        <AlertDialogContent
          className="max-h-[85dvh] overflow-y-auto"
          style={{ background: 'var(--popover)' }}
        >
          <AlertDialogTitle>{t('trash.confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('trash.confirmDescription')}
          </AlertDialogDescription>
          <p className="break-all text-xs">{plan?.path}</p>
          <label className="space-y-2 text-sm [overflow-wrap:anywhere]">
            <span>{t('trash.typeName', { name: plan?.name })}</span>
            <Input
              value={name}
              disabled={mutation.isPending}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </label>
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t('trash.failed')}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-auto max-w-full whitespace-normal bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={mutation.isPending || name !== plan?.name}
              onClick={(event) => {
                event.preventDefault();
                if (plan && name === plan.name) mutation.mutate();
              }}
            >
              {t('trash.move')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
interface TrashEntry {
  id: string;
  name: string;
  originalPath: string;
  kind: string;
  createdAt: number;
  actorName: string;
}
export function ProjectIntegrityTrash({ projectId }: { projectId: string }) {
  const { t } = useTranslation('integrity');
  const client = useQueryClient();
  const [selected, setSelected] = useState<TrashEntry | null>(null);
  const query = useQuery({
    queryKey: trashKey(projectId),
    queryFn: () =>
      integrityRequest<{ entries: TrashEntry[] }>(
        '/' + encodeURIComponent(projectId) + '/trash',
      ),
    enabled: !!projectId,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const restore = useMutation({
    mutationFn: (entry: TrashEntry) =>
      integrityRequest<{ path: string }>(
        '/' + encodeURIComponent(projectId) + '/trash/recover',
        { entryId: entry.id, confirmation: 'RECOVER_PROJECT_TRASH' },
      ),
    onSuccess: () => {
      setSelected(null);
      void client.invalidateQueries({ queryKey: trashKey(projectId) });
      void client.invalidateQueries({
        queryKey: ['project-integrity', projectId],
      });
    },
  });
  if (!projectId) return null;
  return (
    <section className="min-w-0 space-y-2 rounded-lg border p-3">
      <details>
        <summary className="cursor-pointer py-1 font-medium">
          {t('trash.title', { count: query.data?.entries?.length ?? 0 })}
        </summary>
        <p className="my-3 text-sm text-muted-foreground">{t('trash.help')}</p>
        {query.isError && <p role="alert">{t('trash.loadFailed')}</p>}
        {query.isPending && <p role="status">{t('scanning')}</p>}
        {!query.isPending && !query.isError && !query.data?.entries?.length && (
          <p className="text-sm">{t('trash.empty')}</p>
        )}
        <ul className="space-y-3">
          {query.data?.entries?.map((entry) => (
            <li key={entry.id} className="min-w-0 space-y-2 border-t pt-3">
              <p className="break-all font-medium">{entry.name}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(entry.createdAt).toLocaleString()} · {entry.actorName}
              </p>
              <p className="break-all text-xs">{entry.originalPath}</p>
              <Button
                variant="outline"
                className="h-auto whitespace-normal"
                onClick={() => {
                  restore.reset();
                  setSelected(entry);
                }}
              >
                <RotateCcw className="h-4 w-4 shrink-0" />
                {t('trash.recover')}
              </Button>
            </li>
          ))}
        </ul>
      </details>
      {restore.isSuccess && (
        <p role="status" className="break-all text-sm">
          {t('trash.recovered', { path: restore.data.path })}
        </p>
      )}
      <AlertDialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !restore.isPending) setSelected(null);
        }}
      >
        <AlertDialogContent
          className="max-h-[85dvh] overflow-y-auto"
          style={{ background: 'var(--popover)' }}
        >
          <AlertDialogTitle>{t('trash.recover')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('trash.recoverDescription')}
          </AlertDialogDescription>
          <p className="break-all text-sm">{selected?.name}</p>
          {restore.isError && (
            <p role="alert" className="text-destructive">
              {t('trash.failed')}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restore.isPending}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={restore.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (selected) restore.mutate(selected);
              }}
            >
              {t('trash.recover')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
