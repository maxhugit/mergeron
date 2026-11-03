import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Folder,
  Files,
  Tags,
  Plus,
  Trash2,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { projectsApi } from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';
import {
  useDocumentOrganization,
  type DocumentLabel,
} from '@/lib/document-organization';
import type { Deliverable, DeliverableDocument } from '@/lib/deliverables-api';
export const DOCUMENT_DRAG_TYPE = 'application/x-mergeron-deliverable-document';
export function DocumentOrganizationPanel({
  item,
  base,
  disabled,
  children,
}: {
  item: Deliverable;
  base: string;
  disabled: boolean;
  children: (
    documents: DeliverableDocument[],
    labels: DocumentLabel[],
    assignments: Record<string, string[]>,
    classify: (document: DeliverableDocument) => void,
  ) => ReactNode;
}) {
  const { t } = useTranslation('deliverables');
  const session = usePlatformSession();
  const client = useQueryClient();
  const query = useDocumentOrganization(base, item.id, item.version),
    data = query.data;
  const [filter, setFilter] = useState('all'),
    [manage, setManage] = useState(false),
    [name, setName] = useState(''),
    [deleting, setDeleting] = useState<DocumentLabel | null>(null),
    [classification, setClassification] = useState<DeliverableDocument | null>(
      null,
    ),
    [planOpen, setPlanOpen] = useState(false),
    [dropTarget, setDropTarget] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: ({
      suffix,
      method = 'POST',
      body = {},
    }: {
      suffix: string;
      method?: string;
      body?: unknown;
    }) =>
      projectsApi(`${base}/${item.id}${suffix}`, {
        method,
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['document-organization'] });
      await client.invalidateQueries({ queryKey: ['project-deliverables'] });
    },
  });
  const active = item.documents.filter((d) => d.deletedAt === null),
    assignments = data?.assignments ?? {},
    labels = data?.labels ?? [];
  const selected = labels.find((l) => l.id === filter),
    visible = active.filter(
      (d) =>
        filter === 'all' ||
        (filter === 'none'
          ? !assignments[d.id]?.length
          : assignments[d.id]?.includes(filter)),
    );
  const busy = disabled || mutation.isPending || !data;
  const assign = (doc: DeliverableDocument, ids: string[]) =>
    mutation.mutate({
      suffix: `/documents/${doc.id}/labels`,
      method: 'PUT',
      body: {
        labelIds: ids,
        expectedRevision: data?.revision,
        expectedVersion: doc.currentVersionNumber,
      },
    });
  const folder = (id: string, label: string, count: number) => (
    <button
      key={id}
      type="button"
      title={label}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent ${filter === id ? 'bg-accent font-medium' : ''} ${dropTarget === id ? 'ring-2 ring-primary' : ''}`}
      onClick={() => setFilter(id)}
      onDragOver={(event) => {
        if (
          !busy &&
          !['all', 'none'].includes(id) &&
          event.dataTransfer.types.includes(DOCUMENT_DRAG_TYPE)
        ) {
          event.preventDefault();
          setDropTarget(id);
        }
      }}
      onDragLeave={() => setDropTarget(null)}
      onDrop={(event) => {
        setDropTarget(null);
        const doc = active.find(
          (d) => d.id === event.dataTransfer.getData(DOCUMENT_DRAG_TYPE),
        );
        if (!busy && doc && !['all', 'none'].includes(id)) {
          event.preventDefault();
          event.stopPropagation();
          assign(doc, [...new Set([...(assignments[doc.id] ?? []), id])]);
        }
      }}
    >
      <Folder className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-xs text-muted-foreground">{count}</span>
    </button>
  );
  const latest = data?.jobs[0],
    proposal = data?.jobs.find(
      (j) => j.mode === 'proposal' && j.status === 'proposed',
    ),
    working = data?.jobs.some((j) => ['queued', 'running'].includes(j.status));
  const unassignedCount = deleting
    ? Object.values(assignments).filter((ids) => ids.includes(deleting.id))
        .length
    : 0;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => setManage(true)}
        >
          <Tags className="h-4 w-4" />
          {t('labelsManage')}
        </Button>
        {session.isAdministrator && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || working}
            onClick={() => {
              setPlanOpen(true);
              mutation.mutate({ suffix: '/organization/proposals' });
            }}
          >
            {working ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {t('labelsPropose')}
          </Button>
        )}
        {proposal && (
          <Button size="sm" variant="outline" onClick={() => setPlanOpen(true)}>
            {t('labelsReviewProposal')}
          </Button>
        )}
        {working && (
          <span role="status" className="text-xs text-muted-foreground">
            {t('labelsWorking')}
          </span>
        )}
        {latest?.status === 'failed' && (
          <span role="alert" className="text-xs text-destructive">
            {t('labelsAiFailed')}
          </span>
        )}
        {latest?.status === 'stale' && (
          <span role="status" className="text-xs text-muted-foreground">
            {t('labelsStale')}
          </span>
        )}
      </div>
      {(query.isError || mutation.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {t('labelsError')}
        </p>
      )}
      <div className="grid min-w-0 gap-4 md:grid-cols-[11rem_minmax(0,1fr)]">
        <aside
          aria-label={t('labelsFolders')}
          className="flex flex-wrap gap-1 md:block md:space-y-1"
        >
          {folder('all', t('labelsAll'), active.length)}
          {folder(
            'none',
            t('labelsUnassigned'),
            active.filter((d) => !assignments[d.id]?.length).length,
          )}
          <div className="flex w-full items-center justify-between px-2 pt-3 text-xs text-muted-foreground">
            {t('labelsFolders')}
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={t('labelsCreate')}
              disabled={busy}
              onClick={() => setManage(true)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          {labels.map((l) =>
            folder(
              l.id,
              l.name,
              active.filter((d) => assignments[d.id]?.includes(l.id)).length,
            ),
          )}
        </aside>
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Files className="h-3.5 w-3.5" />
            {selected?.name ??
              (filter === 'none' ? t('labelsUnassigned') : t('labelsAll'))}
          </div>
          {children(visible, labels, assignments, setClassification)}
          {!visible.length && (
            <p className="py-5 text-center text-sm text-muted-foreground">
              {t('labelsEmpty')}
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            {t('labelsVirtualExplanation')}
          </p>
        </div>
      </div>
      <Dialog open={manage} onOpenChange={setManage}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('labelsManage')}</DialogTitle>
            <DialogDescription>
              {t('labelsVirtualExplanation')}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 space-y-1 overflow-auto">
            {labels.map((l) => (
              <div
                key={l.id}
                className="flex items-center gap-2 rounded-md border px-3 py-2"
              >
                <Folder className="h-4 w-4" />
                <span className="min-w-0 flex-1 break-words">{l.name}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('labelsDeleteNamed', { name: l.name })}
                  disabled={busy}
                  onClick={() => setDeleting(l)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim())
                mutation.mutate(
                  {
                    suffix: '/labels',
                    body: { name, expectedRevision: data?.revision },
                  },
                  { onSuccess: () => setName('') },
                );
            }}
          >
            <Input
              aria-label={t('labelsName')}
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('labelsName')}
              disabled={busy}
            />
            <Button type="submit" disabled={busy || !name.trim()}>
              <Plus className="h-4 w-4" />
              {t('labelsCreate')}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            {t('labelsAutomaticPolicy')}
          </p>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('labelsDeleteNamed', { name: deleting?.name })}
            </DialogTitle>
            <DialogDescription>
              {t('labelsDeleteExplanation')}
            </DialogDescription>
          </DialogHeader>
          {unassignedCount > 0 && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
            >
              {t('labelsDeleteAssigned', { count: unassignedCount })}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t('labelsCancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                deleting &&
                mutation.mutate(
                  {
                    suffix: `/labels/${deleting.id}`,
                    method: 'DELETE',
                    body: {
                      expectedRevision: data?.revision,
                      confirmUnassign: true,
                    },
                  },
                  {
                    onSuccess: () => {
                      setDeleting(null);
                      setFilter('all');
                    },
                  },
                )
              }
            >
              {t('labelsDelete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!classification}
        onOpenChange={(open) => !open && setClassification(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('labelsClassify')}</DialogTitle>
            <DialogDescription>{classification?.name}</DialogDescription>
          </DialogHeader>
          {labels.map((l) => (
            <label key={l.id} className="flex items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                checked={
                  !!classification &&
                  !!assignments[classification.id]?.includes(l.id)
                }
                disabled={busy}
                onChange={(e) =>
                  classification &&
                  assign(
                    classification,
                    e.target.checked
                      ? [...(assignments[classification.id] ?? []), l.id]
                      : (assignments[classification.id] ?? []).filter(
                          (id) => id !== l.id,
                        ),
                  )
                }
              />
              {l.name}
            </label>
          ))}
          {!labels.length && (
            <Button
              onClick={() => {
                setClassification(null);
                setManage(true);
              }}
            >
              {t('labelsCreate')}
            </Button>
          )}
          <Button variant="outline" onClick={() => setClassification(null)}>
            {t('labelsDone')}
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('labelsPropose')}</DialogTitle>
            <DialogDescription>
              {t('labelsProposalExplanation')}
            </DialogDescription>
          </DialogHeader>
          {working && (
            <p role="status" className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('labelsWorking')}
            </p>
          )}
          {proposal?.result && (
            <div className="min-h-0 space-y-4 overflow-auto">
              <p className="text-sm">{proposal.result.reason}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <section>
                  <h3 className="text-sm font-medium">{t('labelsAfter')}</h3>
                  {proposal.result.labels.map((l) => (
                    <p key={l.id} className="text-sm">
                      {labels.some((old) => old.id === l.id)
                        ? labels.find((old) => old.id === l.id)?.name !== l.name
                          ? `${labels.find((old) => old.id === l.id)?.name} → `
                          : '• '
                        : '+ '}
                      {l.name}
                    </p>
                  ))}
                </section>
                <section>
                  <h3 className="text-sm font-medium">{t('labelsRemoved')}</h3>
                  {labels
                    .filter(
                      (l) =>
                        !proposal.result!.labels.some((n) => n.id === l.id),
                    )
                    .map((l) => (
                      <p key={l.id} className="text-sm text-destructive">
                        − {l.name}
                      </p>
                    ))}
                </section>
              </div>
              <div className="divide-y rounded-md border">
                {active.map((doc) => (
                  <div key={doc.id} className="p-3 text-sm">
                    <span className="break-words font-medium">{doc.name}</span>
                    <div className="text-xs text-muted-foreground">
                      {(assignments[doc.id] ?? [])
                        .map((id) => labels.find((l) => l.id === id)?.name)
                        .filter(Boolean)
                        .join(', ') || t('labelsUnassigned')}{' '}
                      →{' '}
                      {(proposal.result!.assignments[doc.id] ?? [])
                        .map(
                          (id) =>
                            proposal.result!.labels.find((l) => l.id === id)
                              ?.name,
                        )
                        .filter(Boolean)
                        .join(', ') || t('labelsUnassigned')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {latest?.status === 'failed' && (
            <p role="alert" className="text-destructive">
              {t('labelsAiFailed')}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPlanOpen(false)}>
              {t('labelsCancel')}
            </Button>
            <Button
              disabled={busy || !proposal || working}
              onClick={() =>
                proposal &&
                mutation.mutate(
                  { suffix: `/organization/proposals/${proposal.id}/apply` },
                  {
                    onSuccess: () => {
                      setPlanOpen(false);
                      setFilter('all');
                    },
                  },
                )
              }
            >
              {t('labelsApply')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
