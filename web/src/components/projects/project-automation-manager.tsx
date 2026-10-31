import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Check,
  Pause,
  Play,
  Plus,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProjectAgentMonitors } from './project-agent-monitors';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  projectsApi,
  type ProjectResourceSummary,
  type ProjectWorkspaceSummary,
  type ProjectWorkspaceTransferSummary,
} from '@/lib/projects-api';

type Automation = {
  id: string;
  name: string;
  instructions: string;
  schedule: 'manual' | 'daily' | 'weekly' | 'monthly';
  time: string;
  weekday: number;
  monthday: number;
  targetType: 'task_board' | 'workspace' | 'workspace_transfer';
  targetId: string;
  mode: 'analysis' | 'proposal' | 'action';
  approvalRequired: boolean;
  active: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
};
type Run = {
  id: string;
  automationId: string;
  status: string;
  result: string;
  error: string;
  startedAt: number;
  finishedAt: number | null;
};
type Board = {
  resource: ProjectResourceSummary;
  targets: ProjectResourceSummary[];
  workspaces: ProjectWorkspaceSummary[];
  transfers: ProjectWorkspaceTransferSummary[];
  automations: Automation[];
  runs: Run[];
};
const blank = {
  name: '',
  instructions: '',
  schedule: 'manual',
  time: '08:00',
  weekday: 1,
  monthday: 1,
  targetType: 'task_board',
  targetId: '',
  mode: 'analysis',
  approvalRequired: true,
  active: true,
} as const;

export function ProjectAutomationManager(props: {
  projectId: string;
  resourceId: string;
}) {
  const { t } = useTranslation('monitors');
  return (
    <Tabs
      defaultValue="actions"
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      <TabsList
        aria-label={t('sections')}
        className="flex shrink-0 flex-wrap gap-1 border-b p-2"
      >
        <TabsTrigger value="actions" className="px-3 py-2 text-sm">
          {t('actionsTab')}
        </TabsTrigger>
        <TabsTrigger value="monitors" className="px-3 py-2 text-sm">
          {t('title')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="actions" className="min-h-0 flex-1 overflow-auto">
        <ScheduledAutomationBoard {...props} />
      </TabsContent>
      <TabsContent
        value="monitors"
        className="flex min-h-0 min-w-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <ProjectAgentMonitors key={props.projectId} projectId={props.projectId} />
      </TabsContent>
    </Tabs>
  );
}

function ScheduledAutomationBoard({
  projectId,
  resourceId,
}: {
  projectId: string;
  resourceId: string;
}) {
  const client = useQueryClient();
  const key = ['project-resource', projectId, resourceId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => projectsApi<Board>(`/${projectId}/resources/${resourceId}`),
    refetchInterval: 10_000,
  });
  const [editing, setEditing] = useState<Automation | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...blank });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const save = useMutation({
    mutationFn: () =>
      projectsApi(
        `/${projectId}/resources/${resourceId}/automations${editing ? `/${editing.id}` : ''}`,
        { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(draft) },
      ),
    onSuccess: () => {
      setOpen(false);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      projectsApi(`/${projectId}/resources/${resourceId}/automations/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: refresh,
  });
  const run = useMutation({
    mutationFn: (id: string) =>
      projectsApi(
        `/${projectId}/resources/${resourceId}/automations/${id}/run`,
        { method: 'POST' },
      ),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: (item: Automation) =>
      projectsApi(
        `/${projectId}/resources/${resourceId}/automations/${item.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ ...item, active: !item.active }),
        },
      ),
    onSuccess: refresh,
  });
  const review = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: string }) =>
      projectsApi(
        `/${projectId}/resources/${resourceId}/automation-runs/${id}`,
        { method: 'PATCH', body: JSON.stringify({ decision }) },
      ),
    onSuccess: refresh,
  });
  if (!query.data)
    return <div className="p-6 text-sm text-muted-foreground">Chargement…</div>;
  const board = query.data;
  const targets = [
    ...board.targets.map((x) => ({
      id: x.id,
      label: x.name,
      type: 'task_board',
    })),
    ...board.workspaces.map((x) => ({
      id: x.path,
      label: x.name,
      type: 'workspace',
    })),
    ...board.transfers.map((x) => ({
      id: x.id,
      label: `Transfert · ${x.name}`,
      type: 'workspace_transfer',
    })),
  ];
  const show = (item?: Automation) => {
    setEditing(item ?? null);
    setDraft(
      item
        ? { ...item }
        : {
            ...blank,
            targetId: targets[0]?.id ?? '',
            targetType: targets[0]?.type ?? 'task_board',
          },
    );
    setOpen(true);
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Zap className="h-5 w-5" />
            {board.resource.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            Automatisations planifiées du projet
          </p>
        </div>
        <Button onClick={() => show()}>
          <Plus className="mr-2 h-4 w-4" />
          Nouvelle automatisation
        </Button>
      </div>
      <div className="overflow-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left">
            <tr>
              <th className="p-3">Automatisation</th>
              <th className="p-3">Planification</th>
              <th className="p-3">Cible</th>
              <th className="p-3">Dernière exécution</th>
              <th className="p-3">Prochaine exécution</th>
              <th className="p-3">État</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {board.automations.map((item) => {
              const target = targets.find((x) => x.id === item.targetId);
              return (
                <tr key={item.id} className="border-t">
                  <td className="p-3">
                    <button
                      className="cursor-pointer font-medium hover:underline"
                      onClick={() => show(item)}
                    >
                      {item.name}
                    </button>
                    <div className="max-w-md truncate text-xs text-muted-foreground">
                      {item.instructions}
                    </div>
                  </td>
                  <td className="p-3">
                    {item.schedule === 'manual'
                      ? 'Manuelle'
                      : `${item.schedule} · ${item.time}`}
                  </td>
                  <td className="p-3">{target?.label ?? 'Cible absente'}</td>
                  <td className="p-3">
                    {item.lastRunAt
                      ? new Date(item.lastRunAt).toLocaleString()
                      : '—'}
                  </td>
                  <td className="p-3">
                    {item.nextRunAt
                      ? new Date(item.nextRunAt).toLocaleString()
                      : '—'}
                  </td>
                  <td className="p-3">
                    {item.active ? 'Active' : 'Suspendue'}
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Exécuter"
                        disabled={run.isPending}
                        onClick={() => run.mutate(item.id)}
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        title={item.active ? 'Suspendre' : 'Activer'}
                        onClick={() => toggle.mutate(item)}
                      >
                        {item.active ? (
                          <Pause className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() =>
                          window.confirm(`Supprimer « ${item.name} » ?`) &&
                          remove.mutate(item.id)
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!board.automations.length && (
              <tr>
                <td
                  colSpan={7}
                  className="p-8 text-center text-muted-foreground"
                >
                  Aucune automatisation
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <section className="min-h-0 overflow-auto rounded-xl border p-4">
        <h2 className="mb-3 font-semibold">Historique des exécutions</h2>
        <div className="space-y-2">
          {board.runs.map((item) => (
            <details key={item.id} className="rounded-lg border p-3">
              <summary className="cursor-pointer">
                <span className="font-medium">
                  {board.automations.find((x) => x.id === item.automationId)
                    ?.name ?? 'Automatisation supprimée'}
                </span>{' '}
                · {item.status} · {new Date(item.startedAt).toLocaleString()}
              </summary>
              <pre className="mt-3 whitespace-pre-wrap text-sm">
                {item.error || item.result}
              </pre>
              {item.status === 'pending_approval' && (
                <div className="mt-3 flex justify-end gap-2 border-t pt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={review.isPending}
                    onClick={() =>
                      review.mutate({ id: item.id, decision: 'rejected' })
                    }
                  >
                    <X className="mr-1 h-4 w-4" />
                    Refuser
                  </Button>
                  <Button
                    size="sm"
                    disabled={review.isPending}
                    onClick={() =>
                      review.mutate({ id: item.id, decision: 'approved' })
                    }
                  >
                    <Check className="mr-1 h-4 w-4" />
                    Valider le rapport
                  </Button>
                </div>
              )}
            </details>
          ))}
          {!board.runs.length && (
            <p className="text-sm text-muted-foreground">
              Aucune exécution enregistrée.
            </p>
          )}
        </div>
      </section>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Modifier' : 'Créer'} une automatisation
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <label className="grid gap-1 text-sm">
              Nom
              <Input
                value={String(draft.name ?? '')}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Instruction
              <Textarea
                rows={5}
                value={String(draft.instructions ?? '')}
                onChange={(e) =>
                  setDraft({ ...draft, instructions: e.target.value })
                }
              />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-sm">
                Planification
                <select
                  className="h-9 rounded-md border bg-background px-3"
                  value={String(draft.schedule)}
                  onChange={(e) =>
                    setDraft({ ...draft, schedule: e.target.value })
                  }
                >
                  <option value="manual">Manuelle</option>
                  <option value="daily">Quotidienne</option>
                  <option value="weekly">Hebdomadaire</option>
                  <option value="monthly">Mensuelle</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Heure
                <Input
                  type="time"
                  value={String(draft.time)}
                  onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                />
              </label>
              {draft.schedule === 'weekly' && (
                <label className="grid gap-1 text-sm">
                  Jour de la semaine
                  <select
                    className="h-9 rounded-md border bg-background px-3"
                    value={Number(draft.weekday ?? 1)}
                    onChange={(e) =>
                      setDraft({ ...draft, weekday: Number(e.target.value) })
                    }
                  >
                    {[
                      'Dimanche',
                      'Lundi',
                      'Mardi',
                      'Mercredi',
                      'Jeudi',
                      'Vendredi',
                      'Samedi',
                    ].map((day, index) => (
                      <option key={day} value={index}>
                        {day}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {draft.schedule === 'monthly' && (
                <label className="grid gap-1 text-sm">
                  Jour du mois
                  <Input
                    type="number"
                    min={1}
                    max={28}
                    value={Number(draft.monthday ?? 1)}
                    onChange={(e) =>
                      setDraft({ ...draft, monthday: Number(e.target.value) })
                    }
                  />
                </label>
              )}
              <label className="grid gap-1 text-sm">
                Cible
                <select
                  className="h-9 rounded-md border bg-background px-3"
                  value={String(draft.targetId)}
                  onChange={(e) => {
                    const x = targets.find((t) => t.id === e.target.value);
                    setDraft({
                      ...draft,
                      targetId: e.target.value,
                      targetType: x?.type,
                    });
                  }}
                >
                  {targets.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Mode
                <select
                  className="h-9 rounded-md border bg-background px-3"
                  value={String(draft.mode)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      mode: e.target.value,
                      approvalRequired: e.target.value !== 'analysis',
                    })
                  }
                >
                  <option value="analysis">Analyse uniquement</option>
                  <option value="proposal">Proposition à valider</option>
                  <option value="action">Action encadrée à valider</option>
                </select>
              </label>
            </div>
            <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              <CalendarClock className="mr-1 inline h-4 w-4" />
              Les modes proposition et action produisent une demande de
              validation ; aucune modification n’est appliquée automatiquement.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button
              disabled={
                save.isPending ||
                !draft.name ||
                !draft.instructions ||
                !draft.targetId
              }
              onClick={() => save.mutate()}
            >
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
