import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Bot,
  ListTodo,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  FileText,
  FolderOpen,
  History,
  Link2,
  ListFilter,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';
import type {
  Deliverable,
  DeliverablesBoard,
  DeliverableVersion,
} from '@/lib/deliverables-api';
import { translationKey } from '@/locales/translation-key';
import { usePlatformSession } from '@/lib/platform-session';
import { withBasePath } from '@/base-path';
import { getAuthorizationHeader } from '@/auth-token';
import { DeliverableDocuments } from './deliverable-documents';
import { ProjectTaskManager } from './project-task-manager';

const lifecycleStatuses = {
  draft: 'Draft',
  in_constitution: 'In constitution',
  awaiting_validation: 'Awaiting validation',
  finalized: 'Finalized',
  archived: 'Archived',
} as const;
function displayedLifecycle(item: Deliverable): keyof typeof lifecycleStatuses {
  return item.lifecycleStatus === 'finalized' &&
    item.validationRequired &&
    item.validationStatus !== 'approved'
    ? 'awaiting_validation'
    : item.lifecycleStatus;
}
const validationStatuses = {
  not_required: 'Not required',
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  outdated: 'Outdated',
} as const;
const validationRequirementActions = {
  enabled: 'Validation enabled',
  disabled: 'Validation disabled',
  cancelled: 'Validation request cancelled',
} as const;
type DetailTab =
  | 'overview'
  | 'documents'
  | 'validation'
  | 'history'
  | 'links'
  | 'access';
type Draft = {
  title: string;
  description: string;
  criteria: string;
  confidentiality: Deliverable['confidentiality'];
  authorizedGroupIds: string[];
  conversations: Deliverable['conversations'];
};
type DeliverableAction = {
  mutate: (input: { suffix?: string; method?: string; body: unknown }) => void;
};

export function ProjectDeliverablesManager({
  projectId,
  resourceId,
  initialDeliverableId,
  onBackToList,
  modalOnly = false,
  onModalClose,
}: {
  projectId: string;
  resourceId: string;
  initialDeliverableId?: string;
  onBackToList?: () => void;
  modalOnly?: boolean;
  onModalClose?: () => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const key = ['project-deliverables', projectId, resourceId];
  const base = `/${projectId}/resources/${resourceId}/deliverables`;
  const query = useQuery({
    queryKey: key,
    queryFn: () => projectsApi<DeliverablesBoard>(base),
    refetchOnWindowFocus: false,
  });
  const [title, setTitle] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTab, setSelectedTab] = useState<DetailTab>('overview');
  const [selected, setSelected] = useState<string | null>(
    initialDeliverableId ?? null,
  );
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [validation, setValidation] = useState('all');
  const [confidentiality, setConfidentiality] = useState('all');
  const [taskAssociation, setTaskAssociation] = useState('all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const canLeave = () =>
    !dirty || window.confirm(t('discardUnsavedDeliverableChanges'));
  const closeModal = () => {
    if (canLeave()) onModalClose?.();
  };
  const wrap = (content: ReactNode) =>
    modalOnly ? (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) closeModal();
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="flex h-[90dvh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl"
        >
          <DialogTitle className="sr-only">
            {query.data?.deliverables.find((item) => item.id === selected)
              ?.title ?? t('deliverables')}
          </DialogTitle>
          {content}
        </DialogContent>
      </Dialog>
    ) : (
      content
    );
  const create = useMutation({
    mutationFn: () =>
      projectsApi<Deliverable>(base, {
        method: 'POST',
        body: JSON.stringify({ title: title.trim() }),
      }),
    onSuccess: async (item) => {
      setTitle('');
      setCreateOpen(false);
      setSelected(item.id);
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const board = query.data;
  const visible = useMemo(
    () =>
      board?.deliverables.filter((item) => {
        const needle = search.trim().toLocaleLowerCase();
        return (
          (status === 'all' || displayedLifecycle(item) === status) &&
          (validation === 'all' || item.validationStatus === validation) &&
          (confidentiality === 'all' ||
            item.confidentiality === confidentiality) &&
          (taskAssociation === 'all' ||
            (taskAssociation === 'linked'
              ? item.primaryTaskId !== null
              : item.primaryTaskId === null)) &&
          (!needle ||
            item.title.toLocaleLowerCase().includes(needle) ||
            item.description.toLocaleLowerCase().includes(needle))
        );
      }) ?? [],
    [board, confidentiality, search, status, taskAssociation, validation],
  );
  const activeFilterCount = [
    search.trim(),
    status !== 'all',
    validation !== 'all',
    confidentiality !== 'all',
    taskAssociation !== 'all',
  ].filter(Boolean).length;
  const resetFilters = () => {
    setSearch('');
    setStatus('all');
    setValidation('all');
    setConfidentiality('all');
    setTaskAssociation('all');
  };
  if (!board)
    return wrap(
      <main className="p-6" role={query.error ? 'alert' : 'status'}>
        {query.error ? t('unableToLoadDeliverables') : t('loading')}
      </main>,
    );
  const current = board.deliverables.find((item) => item.id === selected);
  if (current)
    return wrap(
      <DeliverableDetail
        key={`${current.id}:${current.version}`}
        item={current}
        initialTab={selectedTab}
        board={board}
        base={base}
        refresh={() => client.invalidateQueries({ queryKey: key })}
        onBack={() => {
          if (modalOnly) {
            closeModal();
            return;
          }
          if (canLeave()) {
            setSelected(null);
            onBackToList?.();
          }
        }}
        onRemoved={() => {
          if (modalOnly) onModalClose?.();
          else setSelected(null);
        }}
        onDirty={setDirty}
        embedded={modalOnly}
      />,
    );
  if (modalOnly)
    return wrap(
      <p role="alert" className="p-6">
        {t('unableToLoadDeliverables')}
      </p>,
    );
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="w-full space-y-4 p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{t('deliverables')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('deliverablesListDescription', {
                resource: board.resource.name,
              })}
            </p>
          </div>
          <Button
            type="button"
            onClick={() => {
              setTitle('');
              create.reset();
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t('newDeliverable')}
          </Button>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b bg-muted/20 p-3">
            <div className="flex gap-2">
              <label className="relative min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label={t('searchDeliverable')}
                  className="bg-background pl-9"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('searchDeliverable')}
                />
              </label>
              <Button
                type="button"
                variant="outline"
                className="shrink-0 md:hidden"
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <ListFilter className="h-4 w-4" />
                {t('filters')}
                {activeFilterCount > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </div>
            <div
              className={`${filtersOpen ? 'grid' : 'hidden'} mt-2 gap-2 md:grid md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]`}
            >
              <label>
                <span className="sr-only">{t('filterByStatus')}</span>
                <select
                  aria-label={t('filterByStatus')}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                >
                  <option value="all">{t('allStatuses')}</option>
                  {Object.entries(lifecycleStatuses).map(([value, label]) => (
                    <option key={value} value={value}>
                      {t(translationKey(label))}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="sr-only">{t('filterByValidation')}</span>
                <select
                  aria-label={t('filterByValidation')}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={validation}
                  onChange={(event) => setValidation(event.target.value)}
                >
                  <option value="all">{t('allValidationStatuses')}</option>
                  {Object.entries(validationStatuses)
                    .filter(([value]) => value !== 'cancelled')
                    .map(([value, label]) => (
                      <option key={value} value={value}>
                        {t(translationKey(label))}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                <span className="sr-only">{t('filterByConfidentiality')}</span>
                <select
                  aria-label={t('filterByConfidentiality')}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={confidentiality}
                  onChange={(event) => setConfidentiality(event.target.value)}
                >
                  <option value="all">{t('allConfidentialityLevels')}</option>
                  <option value="standard">{t('standardAccessShort')}</option>
                  <option value="restricted">
                    {t('restrictedAccessShort')}
                  </option>
                </select>
              </label>
              <label>
                <span className="sr-only">{t('filterByTaskAssociation')}</span>
                <select
                  aria-label={t('filterByTaskAssociation')}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={taskAssociation}
                  onChange={(event) => setTaskAssociation(event.target.value)}
                >
                  <option value="all">{t('allTaskAssociations')}</option>
                  <option value="linked">{t('withPrimaryTask')}</option>
                  <option value="unlinked">{t('withoutPrimaryTask')}</option>
                </select>
              </label>
              <Button
                type="button"
                variant="ghost"
                className="justify-start xl:justify-center"
                disabled={activeFilterCount === 0}
                onClick={resetFilters}
              >
                <RotateCcw className="h-4 w-4" />
                {t('resetFilters')}
              </Button>
            </div>
          </div>
          {!visible.length ? (
            <div className="p-10 text-center text-muted-foreground">
              {board.deliverables.length
                ? t('noDeliverableMatchesFilters')
                : t('noDeliverablesYet')}
            </div>
          ) : (
            <DeliverablesList
              items={visible}
              board={board}
              onSelect={(id, tab = 'overview') => {
                setSelectedTab(tab);
                setSelected(id);
              }}
            />
          )}
        </div>
      </div>
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (create.isPending) return;
          setCreateOpen(open);
          setTitle('');
          create.reset();
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('newDeliverable')}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (title.trim() && !create.isPending) create.mutate();
            }}
          >
            <label className="block space-y-2">
              <span className="text-sm font-medium">{t('title')}</span>
              <Input
                autoFocus
                value={title}
                maxLength={160}
                disabled={create.isPending}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t('newDeliverableTitle')}
              />
            </label>
            {create.error && (
              <p role="alert" className="text-sm text-destructive">
                {t('unableToSaveDeliverable')}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => {
                  setCreateOpen(false);
                  setTitle('');
                  create.reset();
                }}
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={!title.trim() || create.isPending}
              >
                {t('create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}

export function DeliverablesList({
  items,
  board,
  onSelect,
}: {
  items: Deliverable[];
  board: DeliverablesBoard;
  onSelect: (id: string, tab?: DetailTab) => void;
}) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWide(entry.contentRect.width >= 576);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [openTask, setOpenTask] = useState<
    DeliverablesBoard['tasks'][number] | null
  >(null);
  return (
    <div ref={container} className="@container">
      {wide && (
        <div className="overflow-x-auto">
          <table
            className="w-full min-w-[850px] table-fixed text-left text-sm"
            aria-label={t('deliverables')}
          >
            <colgroup>
              <col className="w-[20%]" />
              <col className="w-[23%]" />
              <col className="w-[17%]" />
              <col className="w-[20%]" />
              <col className="w-[14%]" />
              <col className="w-[6%]" />
            </colgroup>
            <thead className="border-b bg-muted/40 text-xs font-medium text-muted-foreground">
              <tr>
                {[
                  'title',
                  'documents',
                  'status',
                  'primaryTask',
                  'lastModified',
                  'actions',
                ].map((key) => (
                  <th key={key} scope="col" className="px-4 py-3 font-medium">
                    {t(translationKey(key))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((item) => {
                const task = board.tasks.find(
                  (candidate) => candidate.id === item.primaryTaskId,
                );
                const documents = item.documents.filter(
                  (document) => document.deletedAt === null,
                );
                return (
                  <tr
                    key={item.id}
                    className="align-top transition-colors hover:bg-accent/60"
                  >
                    <td className="px-4 py-4">
                      <button
                        type="button"
                        className="block w-full min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onSelect(item.id)}
                      >
                        <strong className="block truncate" title={item.title}>
                          {item.title}
                        </strong>
                        <span
                          className="mt-1 block truncate text-xs text-muted-foreground"
                          title={item.description}
                        >
                          {item.description || t('noDescription')}
                        </span>
                      </button>
                    </td>
                    <td className="px-4 py-4">
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <FileText className="h-4 w-4 shrink-0" />
                        {documents.length}
                      </span>
                      <ul
                        aria-label={t('documents')}
                        className="mt-2 space-y-1 text-xs"
                      >
                        {documents.map((document) => (
                          <li
                            key={document.id}
                            className="truncate"
                            title={document.name}
                          >
                            {document.name}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="space-y-2 px-4 py-4">
                      <div>
                        <LifecycleBadge status={displayedLifecycle(item)} />
                      </div>
                      <ValidationBadge item={item} />
                      <div>
                        <AccessBadge confidentiality={item.confidentiality} />
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      {task ? (
                        <button
                          type="button"
                          className="block w-full truncate text-left text-blue-700 underline underline-offset-2 dark:text-blue-300"
                          title={task.title}
                          onClick={() => setOpenTask(task)}
                        >
                          {task.title}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t('noPrimaryTask')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-xs text-muted-foreground">
                      <time dateTime={new Date(item.updatedAt).toISOString()}>
                        {new Date(item.updatedAt).toLocaleDateString()}
                      </time>
                    </td>
                    <td className="px-1 py-3">
                      <DeliverableRowActions
                        item={item}
                        onSelect={onSelect}
                        onTask={task ? () => setOpenTask(task) : undefined}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!wide && (
        <div className="divide-y">
          {items.map((item) => {
            const task = board.tasks.find(
              (candidate) => candidate.id === item.primaryTaskId,
            );
            const documents = item.documents.filter(
              (document) => document.deletedAt === null,
            );
            return (
              <div
                key={item.id}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-accent/60 @min-[68rem]:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_120px_120px_minmax(0,1.5fr)_120px_95px] @min-[68rem]:items-center @min-[68rem]:gap-3"
              >
                <button
                  type="button"
                  className="col-start-1 row-start-1 min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @min-[68rem]:col-auto @min-[68rem]:row-auto"
                  onClick={() => onSelect(item.id)}
                >
                  <strong className="block truncate">{item.title}</strong>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {item.description || t('noDescription')}
                  </span>
                </button>
                <div className="col-start-1 row-start-2 min-w-0 text-sm @min-[68rem]:col-auto @min-[68rem]:row-auto">
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground @min-[68rem]:hidden">
                      {t('documents')}:
                    </span>
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    {documents.length}
                  </span>
                  <ul
                    aria-label={t('documents')}
                    className="mt-1 hidden min-w-0 space-y-1 text-xs text-muted-foreground @min-[36rem]:block"
                  >
                    {documents.map((document) => (
                      <li
                        key={document.id}
                        className="truncate"
                        title={document.name}
                      >
                        {document.name}
                      </li>
                    ))}
                  </ul>
                </div>
                <span
                  data-testid={`deliverable-status-${item.id}`}
                  className="col-start-2 row-start-1 justify-self-end @min-[68rem]:col-auto @min-[68rem]:row-auto @min-[68rem]:justify-self-auto"
                >
                  <LifecycleBadge status={displayedLifecycle(item)} />
                </span>
                <ValidationBadge
                  item={item}
                  className="col-start-2 row-start-2 justify-self-end @min-[68rem]:col-auto @min-[68rem]:row-auto @min-[68rem]:justify-self-auto"
                />
                <span className="col-start-1 row-start-3 flex min-w-0 items-center gap-2 text-sm @min-[68rem]:col-auto @min-[68rem]:row-auto">
                  <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {task ? (
                    <button
                      type="button"
                      className="truncate rounded text-left font-medium text-blue-700 underline decoration-blue-500/40 underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-300"
                      onClick={() => setOpenTask(task)}
                    >
                      {task.title}
                    </button>
                  ) : (
                    <span className="truncate text-muted-foreground">
                      {t('noPrimaryTask')}
                    </span>
                  )}
                </span>
                <AccessBadge
                  confidentiality={item.confidentiality}
                  className="col-start-2 row-start-3 justify-self-end @min-[68rem]:col-auto @min-[68rem]:row-auto @min-[68rem]:justify-self-auto"
                />
                <span className="col-start-1 row-start-4 text-xs text-muted-foreground @min-[68rem]:col-auto @min-[68rem]:row-auto">
                  {new Date(item.updatedAt).toLocaleDateString()}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {openTask && (
        <ProjectTaskManager
          projectId={board.resource.projectId}
          resourceId={openTask.resourceId}
          initialTaskId={openTask.id}
          modalOnly
          onModalClose={() => setOpenTask(null)}
        />
      )}
    </div>
  );
}

function DeliverableRowActions({
  item,
  onSelect,
  onTask,
}: {
  item: Deliverable;
  onSelect: (id: string, tab?: DetailTab) => void;
  onTask?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`${t('actions')} : ${item.title}`}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-56 p-1"
        aria-label={`${t('actions')} : ${item.title}`}
      >
        {(['overview', 'documents', 'history', 'validation'] as const).map(
          (tab) => (
            <Button
              key={tab}
              type="button"
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                setOpen(false);
                onSelect(item.id, tab);
              }}
            >
              {t(translationKey(tab))}
            </Button>
          ),
        )}
        <div className="my-1 border-t" />
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start"
          disabled={!onTask}
          onClick={() => {
            setOpen(false);
            onTask?.();
          }}
        >
          {t('primaryTask')}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function ValidationBadge({
  item,
  className = '',
}: {
  item: Pick<Deliverable, 'validationStatus' | 'validationRequired'>;
  className?: string;
}) {
  const { t } = useTranslation();
  const color =
    item.validationStatus === 'approved'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : item.validationStatus === 'rejected'
        ? 'bg-red-500/15 text-red-700 dark:text-red-300'
        : item.validationStatus === 'pending'
          ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
          : item.validationStatus === 'outdated'
            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
            : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`flex w-fit items-center gap-2 rounded-md px-2 py-1 text-xs font-medium ${color} ${className}`}
    >
      <CheckCircle2 className="h-4 w-4 shrink-0" />
      {item.validationRequired && item.validationStatus === 'not_required'
        ? t('required')
        : t(translationKey(validationStatuses[item.validationStatus]))}
    </span>
  );
}

function AccessBadge({
  confidentiality,
  className = '',
}: {
  confidentiality: Deliverable['confidentiality'];
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={`w-fit rounded-md px-2 py-1 text-xs font-medium ${confidentiality === 'restricted' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' : 'bg-muted text-muted-foreground'} ${className}`}
    >
      {t(
        confidentiality === 'restricted'
          ? 'restrictedAccessShort'
          : 'standardAccessShort',
      )}
    </span>
  );
}

function LifecycleBadge({
  status,
}: {
  status: keyof typeof lifecycleStatuses;
}) {
  const { t } = useTranslation();
  const color =
    status === 'finalized'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : status === 'awaiting_validation'
        ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
        : status === 'archived'
          ? 'bg-muted text-muted-foreground'
          : status === 'in_constitution'
            ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
            : 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return (
    <span
      className={`w-fit rounded-full px-2.5 py-1 text-xs font-medium ${color}`}
    >
      {t(translationKey(lifecycleStatuses[status]))}
    </span>
  );
}

export function LifecycleActions({
  item,
  busy,
  action,
}: {
  item: Deliverable;
  busy: boolean;
  action: DeliverableAction;
}) {
  const { t } = useTranslation(['deliverables', 'common'], {
    nsMode: 'fallback',
  });
  const [open, setOpen] = useState(false);
  const targets: Partial<
    Record<
      Deliverable['lifecycleStatus'],
      Array<{
        target: Deliverable['lifecycleStatus'];
        label: string;
        variant?: 'default' | 'outline';
      }>
    >
  > = {
    draft: [
      { target: 'in_constitution', label: 'Start constitution' },
      { target: 'finalized', label: 'Finalize' },
    ],
    in_constitution: [
      { target: 'draft', label: 'Return to draft', variant: 'outline' },
      { target: 'finalized', label: 'Finalize' },
    ],
    finalized: [
      { target: 'in_constitution', label: 'Reopen', variant: 'outline' },
      { target: 'archived', label: 'Archive' },
    ],
    archived: [{ target: 'finalized', label: 'Unarchive' }],
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" disabled={busy}>
          {t('changeDeliverableStatus')}
          <ChevronDown className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-60 p-1"
        aria-label={t('changeDeliverableStatus')}
      >
        {targets[item.lifecycleStatus]?.map(({ target, label }) => (
          <Button
            key={target}
            variant="ghost"
            className="w-full justify-start"
            disabled={
              busy ||
              (target === 'finalized' &&
                item.documents.every((document) => document.deletedAt !== null))
            }
            onClick={() => {
              setOpen(false);
              action.mutate({
                suffix: '/lifecycle',
                body: { target, version: item.version },
              });
            }}
          >
            {t(translationKey(label))}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function DeliverableHeaderSlot({
  id,
  children,
}: {
  id?: string;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!id) return;
    const update = () => {
      const element = document.getElementById(id);
      setTarget(element);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [id]);
  return target ? (
    createPortal(children, target)
  ) : (
    <div className={`shrink-0 px-4 py-2 ${!id ? 'pr-12' : ''}`}>{children}</div>
  );
}

function DeliverableDetail({
  item,
  board,
  base,
  refresh,
  onBack,
  onRemoved,
  onDirty,
  embedded = false,
  initialTab = 'overview',
}: {
  item: Deliverable;
  board: DeliverablesBoard;
  base: string;
  refresh: () => Promise<unknown>;
  onBack: () => void;
  onRemoved: () => void;
  onDirty: (dirty: boolean) => void;
  embedded?: boolean;
  initialTab?: DetailTab;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const session = usePlatformSession();
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState(item.title);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [agentSubtaskId, setAgentSubtaskId] = useState('__new__');
  const [agentSubtaskTitle, setAgentSubtaskTitle] = useState(
    t('produceDeliverableSubtask', { title: item.title }),
  );
  const [draft, setDraft] = useState<Draft>({
    title: item.title,
    description: item.description,
    criteria: item.criteria,
    confidentiality: item.confidentiality,
    authorizedGroupIds: item.authorizedGroupIds,
    conversations: item.conversations,
  });
  const [error, setError] = useState('');
  const [revisionDirty, setRevisionDirty] = useState(false);
  useEffect(() => {
    onDirty(revisionDirty);
    return () => onDirty(false);
  }, [revisionDirty, onDirty]);
  const fail = (failure?: unknown) =>
    setError(
      failure instanceof Error && failure.message
        ? failure.message
        : t('theDeliverableCouldNotBeUpdatedReloadToCheckForConcurrentChanges'),
    );
  const action = useMutation({
    mutationFn: ({
      suffix = '',
      method = 'POST',
      body,
    }: {
      suffix?: string;
      method?: string;
      body: unknown;
    }) =>
      projectsApi(`${base}/${item.id}${suffix}`, {
        method,
        body: JSON.stringify(body),
      }),
    onSuccess: async (_, input) => {
      if (input.method === 'DELETE') onRemoved();
      await refresh();
    },
    onError: fail,
  });
  const agent = useMutation({
    mutationFn: (input: { subtaskId?: string; subtaskTitle?: string }) =>
      projectsApi<{ threadId: string; taskId: string }>(
        `${base}/${item.id}/agent`,
        {
          method: 'POST',
          body: JSON.stringify({ version: item.version, ...input }),
        },
      ),
    onSuccess: async ({ threadId }) => {
      setAgentDialogOpen(false);
      await refresh();
      await navigate({ to: '/t/$threadId', params: { threadId } });
    },
    onError: fail,
  });
  const rename = useMutation({
    mutationFn: () =>
      projectsApi(`${base}/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: renameTitle.trim(),
          version: item.version,
        }),
      }),
    onSuccess: async () => {
      setRenameOpen(false);
      await refresh();
    },
    onError: fail,
  });
  const busy = action.isPending || agent.isPending || rename.isPending;
  const primaryTask = board.tasks.find(
    (task) => task.id === item.primaryTaskId,
  );
  const availableSubtasks = board.tasks.filter(
    (task) => task.parentTaskId === item.primaryTaskId && !task.linkedThreadId,
  );
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setRevisionDirty(true);
  };
  const download = async (version: DeliverableVersion, index: number) => {
    try {
      const authorization = getAuthorizationHeader();
      const response = await fetch(
        withBasePath(
          `/api/projects${base}/${item.id}/versions/${version.id}/files/${index}`,
        ),
        { headers: authorization ? { Authorization: authorization } : {} },
      );
      if (!response.ok) throw new Error('download');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = version.files[index].name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      fail();
    }
  };
  const tabs: Array<{ id: DetailTab; label: string; icon: typeof FileText }> = [
    { id: 'overview', label: t('overview'), icon: FolderOpen },
    { id: 'documents', label: t('documents'), icon: FileText },
    { id: 'validation', label: t('validation'), icon: CheckCircle2 },
    { id: 'history', label: t('history'), icon: History },
    { id: 'links', label: t('primaryTask'), icon: Link2 },
    { id: 'access', label: t('deliverableAccess'), icon: ShieldCheck },
  ];
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DeliverableHeaderSlot
        id={
          embedded
            ? undefined
            : `deliverable-header-${base.split('/')[1]}-${base.split('/')[3]}`
        }
      >
        <div
          data-deliverable-header
          className="flex min-w-0 items-center gap-2"
        >
          {!embedded && (
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('backToDeliverables')}
              title={t('backToDeliverables')}
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-semibold sm:text-base">
                {item.title}
              </h1>{' '}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('renameDeliverable')}
                title={t('renameDeliverable')}
                disabled={
                  busy || revisionDirty || item.lifecycleStatus === 'archived'
                }
                onClick={() => {
                  setRenameTitle(item.title);
                  setRenameOpen(true);
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <LifecycleBadge status={displayedLifecycle(item)} />
        </div>
      </DeliverableHeaderSlot>

      <div className="z-10 shrink-0 border-b bg-background/95 backdrop-blur">
        <div className="w-full px-2 md:px-4">
          <div
            className="flex gap-1 overflow-x-auto"
            role="tablist"
            aria-label={t('deliverableSections')}
          >
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm ${tab === id ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                onClick={() => setTab(id)}
              >
                <Icon className="h-4 w-4" />
                {label}
                {id === 'documents' && (
                  <span className="rounded-full bg-muted px-1.5 text-xs">
                    {
                      item.documents.filter(
                        (document) => document.deletedAt === null,
                      ).length
                    }
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full space-y-4 p-4 md:p-6">
          {tab === 'overview' && (
            <Overview
              item={item}
              board={board}
              draft={draft}
              set={set}
              busy={busy || item.lifecycleStatus === 'archived'}
              base={base}
            />
          )}
          {tab === 'access' && (
            <AccessSettings
              board={board}
              draft={draft}
              set={set}
              busy={busy || item.lifecycleStatus === 'archived'}
            />
          )}
          {tab === 'documents' && (
              <DeliverableDocuments
                item={item}
                base={base}
                disabled={
                  busy ||
                  revisionDirty ||
                  !['draft', 'in_constitution'].includes(item.lifecycleStatus)
                }
                refresh={refresh}
                onError={fail}
              />
          )}
          {tab === 'history' && (
            <DeliverableHistory item={item} download={download} />
          )}
          {tab === 'validation' && (
            <VersionHistory
              mode={tab}
              item={item}
              busy={busy}
              dirty={revisionDirty}
              action={action}
            />
          )}
          {tab === 'links' && (
            <Links
              item={item}
              board={board}
              base={base}
              busy={busy || item.lifecycleStatus === 'archived'}
              refresh={refresh}
            />
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
      <footer className="z-10 shrink-0 border-t bg-background/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur md:px-6">
        <div className="mx-auto flex w-full flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2">
            <LifecycleActions
              item={item}
              busy={busy || revisionDirty}
              action={action}
            />
            {item.lifecycleStatus === 'finalized' &&
              item.validationRequired &&
              item.validationStatus !== 'approved' &&
              !item.validations.some(
                (validation) => validation.effectiveStatus === 'pending',
              ) && (
                <Button
                  disabled={
                    busy ||
                    revisionDirty ||
                    !item.documents.some(
                      (document) => document.deletedAt === null,
                    )
                  }
                  onClick={() =>
                    action.mutate({
                      suffix: '/validations',
                      body: { version: item.version },
                    })
                  }
                >
                  {t('submitDeliverableForValidation')}
                </Button>
              )}
            {session.isAdministrator && (
              <Button
                variant="outline"
                disabled={
                  busy || revisionDirty || item.lifecycleStatus === 'archived'
                }
                onClick={() => setAgentDialogOpen(true)}
              >
                {t('entrustDeliverableToAgent')}
              </Button>
            )}
          </div>{' '}
          <div className="ml-auto flex flex-wrap justify-end gap-2">
            <Button
              disabled={
                busy ||
                item.lifecycleStatus === 'archived' ||
                !revisionDirty ||
                !draft.title.trim() ||
                (draft.confidentiality === 'restricted' &&
                  !draft.authorizedGroupIds.length)
              }
              onClick={() =>
                action.mutate({
                  method: 'PATCH',
                  body: { ...draft, version: item.version },
                })
              }
            >
              {t('save')}
            </Button>
            <Button
              variant="outline"
              disabled={busy || item.lifecycleStatus === 'archived'}
              onClick={() => {
                if (
                  window.confirm(
                    t(
                      'removeThisDeliverableRecordAndItsVersionHistoryAllFilesWillBePreserved',
                    ),
                  )
                )
                  action.mutate({
                    method: 'DELETE',
                    body: { version: item.version },
                  });
              }}
            >
              {t('removeRecord')}
            </Button>
          </div>
        </div>
      </footer>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('renameDeliverable')}</DialogTitle>
            <DialogDescription>
              {t('renameDeliverableDescription')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (renameTitle.trim() && renameTitle.trim() !== item.title)
                rename.mutate();
            }}
          >
            <Input
              autoFocus
              aria-label={t('deliverableName')}
              value={renameTitle}
              maxLength={160}
              onChange={(event) => setRenameTitle(event.target.value)}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameOpen(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                disabled={
                  rename.isPending ||
                  !renameTitle.trim() ||
                  renameTitle.trim() === item.title
                }
              >
                {t('rename')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={agentDialogOpen} onOpenChange={setAgentDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('entrustDeliverableToAgent')}</DialogTitle>
            <DialogDescription>
              {primaryTask
                ? t('deliverableAgentRequiresSubtask')
                : t('deliverableAgentAutomaticExecution')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (agentSubtaskId === '__new__') {
                if (agentSubtaskTitle.trim())
                  agent.mutate({ subtaskTitle: agentSubtaskTitle.trim() });
              } else agent.mutate({ subtaskId: agentSubtaskId });
            }}
          >
            <label className="block space-y-1 text-sm">
              <span>{t('executionSubtask')}</span>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={agentSubtaskId}
                disabled={agent.isPending}
                onChange={(event) => setAgentSubtaskId(event.target.value)}
              >
                <option value="__new__">
                  {primaryTask
                    ? t('createDedicatedSubtask')
                    : t('createAutomaticExecutionUnit')}
                </option>
                {availableSubtasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>
            {agentSubtaskId === '__new__' && (
              <label className="block space-y-1 text-sm">
                <span>{t('subtaskTitle')}</span>
                <Input
                  value={agentSubtaskTitle}
                  maxLength={200}
                  disabled={agent.isPending}
                  onChange={(event) => setAgentSubtaskTitle(event.target.value)}
                />
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              {t('agentDeliverableRoleIsTraceability')}
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={agent.isPending}
                onClick={() => setAgentDialogOpen(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                disabled={
                  agent.isPending ||
                  (agentSubtaskId === '__new__' && !agentSubtaskTitle.trim())
                }
              >
                {t('createWorkAgent')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function DeliverableFolderSelector({
  item,
  base,
  busy,
}: {
  item: Deliverable;
  base: string;
  busy: boolean;
}) {
  const { t } = useTranslation(['deliverables', 'common'], {
    nsMode: 'fallback',
  });
  const client = useQueryClient();
  const projectId = base.split('/')[1];
  const [editing, setEditing] = useState(false);
  const [resourceId, setResourceId] = useState(
    item.activeFolder?.resourceId ?? '',
  );
  const [relativePath, setRelativePath] = useState(
    item.activeFolder?.relativePath ?? '',
  );
  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
  });
  const workspaces =
    projects.data?.projects?.find((project) => project.id === projectId)
      ?.workspaces ?? [];
  const change = useMutation({
    mutationFn: () =>
      projectsApi(`/${projectId}/active-folders/deliverable/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ resourceId, relativePath }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: projectsQueryKey });
      await client.invalidateQueries({
        queryKey: ['project-deliverables', projectId],
      });
      setEditing(false);
    },
  });
  return (
    <div className="mt-3 space-y-2">
      <Button
        variant="outline"
        disabled={busy || item.lifecycleStatus === 'archived'}
        onClick={() => {
          setResourceId(item.activeFolder?.resourceId ?? '');
          setRelativePath(item.activeFolder?.relativePath ?? '');
          change.reset();
          setEditing(true);
        }}
      >
        {t('selectDeliverableFolder')}
      </Button>
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (!change.isPending) setEditing(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('selectDeliverableFolder')}</DialogTitle>
            <DialogDescription>
              {t('deliverableFolderSelectionHelp')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              change.mutate();
            }}
          >
            <label className="grid gap-1 text-sm">
              {t('workingFolder')}
              <select
                className="min-w-0 rounded border bg-background p-2"
                value={resourceId}
                disabled={change.isPending}
                onChange={(event) => setResourceId(event.target.value)}
              >
                <option value="" disabled>
                  {t('chooseAFolder')}
                </option>
                {workspaces
                  .filter((workspace) => !workspace.readOnly)
                  .map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              {t('deliverableRelativeFolder')}
              <Input
                value={relativePath}
                disabled={change.isPending}
                onChange={(event) => setRelativePath(event.target.value)}
              />
            </label>
            {change.isError && (
              <p role="alert" className="text-sm text-destructive">
                {t('deliverableFolderSelectionFailed')}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={change.isPending}
                onClick={() => setEditing(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={!resourceId || change.isPending || projects.isLoading}
              >
                {t('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function DeliverableLifecycleFlow({ item }: { item: Deliverable }) {
  const { t } = useTranslation(['deliverables', 'common'], {
    nsMode: 'fallback',
  });
  const definitions = {
    draft: 'lifecycleDraftDefinition',
    in_constitution: 'lifecycleConstitutionDefinition',
    awaiting_validation: 'lifecycleValidationDefinition',
    finalized: 'lifecycleFinalizedDefinition',
    archived: 'lifecycleArchivedDefinition',
  } as const;
  const current = displayedLifecycle(item);
  const stages = (
    Object.keys(lifecycleStatuses) as Array<keyof typeof lifecycleStatuses>
  ).filter(
    (stage) => stage !== 'awaiting_validation' || item.validationRequired,
  );
  return (
    <section
      className="col-span-full min-w-0"
      aria-label={t('deliverableLifecycleFlow')}
    >
      <TooltipProvider>
        <ol className="flex w-full items-center justify-between gap-3 overflow-x-auto p-1">
          {stages.map((stage, index) => (
            <li
              key={stage}
              className={`flex shrink-0 items-center gap-3 ${index > 0 ? 'grow justify-between' : ''}`}
              aria-current={stage === current ? 'step' : undefined}
            >
              {index > 0 && <span aria-hidden="true">→</span>}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className={
                      stage === current
                        ? 'shrink-0 whitespace-nowrap rounded-full ring-2 ring-primary ring-offset-2 ring-offset-background focus-visible:outline-none'
                        : 'shrink-0 whitespace-nowrap rounded-full opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                    }
                  >
                    <LifecycleBadge status={stage} />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {t(translationKey(definitions[stage]))}
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ol>
      </TooltipProvider>
    </section>
  );
}

function Overview({
  item,
  board,
  draft,
  set,
  busy,
  base,
}: {
  item: Deliverable;
  board: DeliverablesBoard;
  draft: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  busy: boolean;
  base: string;
}) {
  const { t } = useTranslation();
  const [openTask, setOpenTask] = useState(false);
  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
  });
  const projectAgents = projects.data?.projects?.find(
    (project) => project.id === base.split('/')[1],
  )?.agentThreads;
  const agentIds = [
    ...new Set(
      item.conversations
        .filter((link) => link.type === 'agent')
        .map((link) => link.id),
    ),
  ];
  const assignedAgents = agentIds
    .map((id) => {
      const title =
        projectAgents?.find((agent) => agent.threadId === id)?.title?.trim() ||
        board.conversations
          .find((link) => link.type === 'agent' && link.id === id)
          ?.title?.trim();
      return { id, title };
    })
    .filter(
      (agent): agent is { id: string; title: string } =>
        !!agent.title &&
        agent.title !== agent.id &&
        agent.title !== t('openDeliverableAgent'),
    );
  const primaryTask = board.tasks.find(
    (task) => task.id === item.primaryTaskId,
  );
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <DeliverableLifecycleFlow item={item} />
      <section className="min-w-0 space-y-3 rounded-xl border bg-card p-4">
        <h2 className="font-semibold">{t('generalInformation')}</h2>
        <label className="block text-sm">
          {t('title')}
          <Input
            className="mt-1"
            disabled={busy}
            value={draft.title}
            onChange={(event) => set('title', event.target.value)}
          />
        </label>
        <label className="block text-sm">
          {t('description')}
          <Textarea
            className="mt-1"
            rows={2}
            disabled={busy}
            value={draft.description}
            onChange={(event) => set('description', event.target.value)}
          />
        </label>
        <label className="block text-sm">
          {t('validationCriteria')}
          <Textarea
            className="mt-1"
            rows={2}
            disabled={busy}
            value={draft.criteria}
            onChange={(event) => set('criteria', event.target.value)}
          />
        </label>
      </section>
      <aside className="grid min-w-0 content-start gap-2 sm:grid-cols-2">
        <section
          aria-label={t('primaryTask')}
          className="col-span-full min-w-0 rounded-xl border bg-card p-3 text-sm"
        >
          <p className="mb-1 flex items-center gap-2 text-muted-foreground">
            <ListTodo className="h-4 w-4 shrink-0" />
            {t('primaryTask')}
          </p>
          {primaryTask ? (
            <button
              className="font-medium underline"
              onClick={() => setOpenTask(true)}
            >
              {primaryTask.title}
            </button>
          ) : (
            <span>{t('noPrimaryTask')}</span>
          )}
          <dl className="mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="mb-1 flex items-center gap-2 text-muted-foreground">
                <UserRound className="h-4 w-4 shrink-0" />
                {t('responsiblePerson')}
              </dt>
              <dd className="break-words font-medium">
                {primaryTask?.assigneeName ?? t('unassigned')}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="mb-1 flex items-center gap-2 text-muted-foreground">
                <CalendarDays className="h-4 w-4 shrink-0" />
                {t('dueDate')}
              </dt>
              <dd className="font-medium">
                {primaryTask?.dueAt
                  ? new Date(primaryTask.dueAt).toLocaleDateString(undefined, {
                      timeZone: 'UTC',
                    })
                  : t('notDefined')}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            {t('planningInheritedFromPrimaryTask')}
          </p>
        </section>
        <div className="rounded-xl border bg-card p-3 text-sm">
          <p className="mb-1 flex items-center gap-2 text-muted-foreground">
            <Bot className="h-4 w-4 shrink-0" />
            {t('assignedDeliverableAgent')}
          </p>
          {assignedAgents.length ? (
            assignedAgents.map((agent) => (
              <a
                key={agent.id}
                className="block font-medium underline"
                href={withBasePath('/t/' + encodeURIComponent(agent.id))}
              >
                {agent.title}
              </a>
            ))
          ) : (
            <span>
              {t(agentIds.length ? 'notDefined' : 'noDeliverableAgent')}
            </span>
          )}
        </div>
        {openTask && primaryTask && (
          <ProjectTaskManager
            projectId={base.split('/')[1]}
            resourceId={primaryTask.resourceId}
            initialTaskId={primaryTask.id}
            modalOnly
            onModalClose={() => setOpenTask(false)}
          />
        )}

        <Summary
          icon={CheckCircle2}
          title={t('validation')}
          value={<ValidationBadge item={item} />}
        />
        <Summary
          icon={UserRound}
          title={t('confidentiality')}
          value={<AccessBadge confidentiality={item.confidentiality} />}
        />
        <div className="col-span-full min-w-0 rounded-xl border bg-card p-4">
          <div className="mb-2 flex items-center gap-2 font-medium">
            <FolderOpen className="h-4 w-4" />
            {t('location')}
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {item.directory}
          </p>
          {item.activeFolder && item.activeFolder.state !== 'ready' && (
            <p className="mt-2 text-xs font-medium text-destructive">
              {t('activeFolderNeedsResolution')}
            </p>
          )}
          <DeliverableFolderSelector item={item} base={base} busy={busy} />
        </div>
      </aside>
      <section className="col-span-full rounded-xl border bg-card p-4">
        <h2 className="mb-3 font-semibold">{t('systemInformation')}</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">{t('deliverableCreator')}</dt>
            <dd>{item.createdByName ?? t('notDefined')}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('createdOn')}</dt>
            <dd>{new Date(item.createdAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {t('deliverableLastEditor')}
            </dt>
            <dd>{item.updatedByName ?? t('notDefined')}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('lastModified')}</dt>
            <dd>{new Date(item.updatedAt).toLocaleString()}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
function AccessSettings({
  board,
  draft,
  set,
  busy,
}: {
  board: DeliverablesBoard;
  draft: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className="w-full space-y-4 rounded-xl border bg-card p-4">
      <h2 className="font-semibold">{t('deliverableAccess')}</h2>
      <label className="block text-sm">
        {t('confidentiality')}
        <select
          className="mt-1 w-full rounded border bg-background p-2"
          disabled={busy}
          value={draft.confidentiality}
          onChange={(event) =>
            set(
              'confidentiality',
              event.target.value as Draft['confidentiality'],
            )
          }
        >
          <option value="standard">{t('standardAccess')}</option>
          <option value="restricted">{t('restrictedAccess')}</option>
        </select>
      </label>
      {draft.confidentiality === 'restricted' && (
        <fieldset className="space-y-2 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">
            {t('authorizedGroups')}
          </legend>
          {!board.personGroups.length && (
            <p className="text-sm text-muted-foreground">
              {t('createAProjectGroupBeforeRestrictingAccess')}
            </p>
          )}
          {board.personGroups.map((group) => (
            <label className="flex items-center gap-2 text-sm" key={group.id}>
              <input
                type="checkbox"
                disabled={busy}
                checked={draft.authorizedGroupIds.includes(group.id)}
                onChange={(event) =>
                  set(
                    'authorizedGroupIds',
                    event.target.checked
                      ? [...draft.authorizedGroupIds, group.id]
                      : draft.authorizedGroupIds.filter(
                          (id) => id !== group.id,
                        ),
                  )
                }
              />
              {group.name}
            </label>
          ))}
        </fieldset>
      )}
    </section>
  );
}

function Summary({
  icon: Icon,
  title,
  value,
}: {
  icon: typeof FileText;
  title: string;
  value: ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        {title}
      </div>
      <strong className="mt-1 block text-sm">{value}</strong>
    </div>
  );
}

function VersionHistory({
  mode,
  item,
  busy,
  dirty,
  action,
}: {
  mode: 'validation' | 'history';
  item: Deliverable;
  busy: boolean;
  dirty: boolean;
  action: DeliverableAction;
}) {
  const { t } = useTranslation();
  const [decisionComment, setDecisionComment] = useState('');
  const [requirementReason, setRequirementReason] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const pendingValidation = item.validations.find(
    (validation) => validation.effectiveStatus === 'pending',
  );
  return (
    <div
      className={
        mode === 'validation'
          ? 'grid gap-4 lg:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]'
          : 'space-y-4'
      }
    >
      {mode === 'validation' && (
        <div className="space-y-4">
          <section className="space-y-3 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">{t('validationRequirement')}</h2>
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
                {t(item.validationRequired ? 'required' : 'notRequired')}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {item.validationRequired
                ? t('validationRequirementEnabledDescription')
                : t('validationRequirementDisabledDescription')}
            </p>
            {item.validationRequired && (
              <Textarea
                value={requirementReason}
                onChange={(event) => setRequirementReason(event.target.value)}
                placeholder={t('validationDisableReason')}
                disabled={busy || dirty || !!pendingValidation}
              />
            )}
            <Button
              variant={item.validationRequired ? 'outline' : 'default'}
              disabled={
                busy ||
                dirty ||
                !!pendingValidation ||
                (item.validationRequired && !requirementReason.trim())
              }
              onClick={() =>
                action.mutate({
                  suffix: '/validation-requirement',
                  body: {
                    required: !item.validationRequired,
                    reason: requirementReason,
                    version: item.version,
                  },
                })
              }
            >
              {item.validationRequired
                ? t('disableValidation')
                : t('enableValidation')}
            </Button>
          </section>
        </div>
      )}
      <div className="space-y-4">
        {mode === 'validation' && (
          <section className="space-y-3 rounded-xl border bg-card p-4">
            <h2 className="font-semibold">{t('validationHistory')}</h2>
            {!item.validations.length && (
              <p className="text-sm text-muted-foreground">
                {t('noValidationRequest')}
              </p>
            )}
            {item.validations.map((validation) => (
              <div
                className="space-y-3 rounded-lg border p-3"
                key={validation.id}
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>
                    {t(
                      translationKey(
                        validationStatuses[validation.effectiveStatus],
                      ),
                    )}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    {new Date(validation.requestedAt).toLocaleString()} ·{' '}
                    {validation.requestedByName}
                  </span>
                </div>
                {validation.decisionComment && (
                  <p className="text-sm">{validation.decisionComment}</p>
                )}
                {validation.effectiveStatus === 'pending' && (
                  <>
                    <Textarea
                      value={decisionComment}
                      onChange={(event) =>
                        setDecisionComment(event.target.value)
                      }
                      placeholder={t('validationDecisionComment')}
                      disabled={busy || dirty}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={busy || dirty}
                        onClick={() =>
                          action.mutate({
                            suffix: `/validations/${validation.id}/decision`,
                            body: {
                              action: 'approve',
                              comment: decisionComment,
                              version: item.version,
                            },
                          })
                        }
                      >
                        {t('approve')}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy || dirty || !decisionComment.trim()}
                        onClick={() =>
                          action.mutate({
                            suffix: `/validations/${validation.id}/decision`,
                            body: {
                              action: 'reject',
                              comment: decisionComment,
                              version: item.version,
                            },
                          })
                        }
                      >
                        {t('reject')}
                      </Button>
                    </div>
                    <Textarea
                      value={cancellationReason}
                      onChange={(event) =>
                        setCancellationReason(event.target.value)
                      }
                      placeholder={t('validationCancellationReason')}
                      disabled={busy || dirty}
                    />
                    <Button
                      variant="ghost"
                      disabled={busy || dirty || !cancellationReason.trim()}
                      onClick={() =>
                        action.mutate({
                          suffix: `/validations/${validation.id}/cancel`,
                          body: {
                            reason: cancellationReason,
                            version: item.version,
                          },
                        })
                      }
                    >
                      {t('cancelValidationRequest')}
                    </Button>
                  </>
                )}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

export function DeliverableHistory({
  item,
  download,
}: {
  item: Deliverable;
  download: (version: DeliverableVersion, index: number) => Promise<void>;
}) {
  const { t } = useTranslation(['deliverables', 'common'], {
    nsMode: 'fallback',
  });
  const events: Array<{
    id: string;
    date: number;
    author: string | null;
    content: ReactNode;
  }> = [
    ...(item.activityEvents ?? []).map((event) => ({
      id: `activity:${event.id}`,
      date: event.createdAt,
      author: event.actorName,
      content: (
        <>
          {t(
            event.action === 'deliverable_document_deleted'
              ? 'deliverableDocumentRemoved'
              : event.action === 'deliverable_document_restored'
                ? 'deliverableDocumentReattached'
                : 'deliverableDetailsChanged',
          )}
          {' — '}
          {event.label}
          {event.action === 'deliverable_updated' &&
            Array.isArray(event.details.fields) && (
              <span className="block text-xs text-muted-foreground">
                {event.details.fields
                  .map((field) => {
                    const labels: Record<string, string> = {
                      title: t('title'),
                      description: t('description'),
                      criteria: t('validationCriteria'),
                      confidentiality: t('confidentiality'),
                      primaryTaskId: t('primaryTask'),
                      authorizedGroupIds: t('deliverableAccess'),
                      conversations: t('assignedDeliverableAgent'),
                    };
                    return (
                      labels[String(field)] ?? t('deliverableOtherDetails')
                    );
                  })
                  .join(', ')}
              </span>
            )}
        </>
      ),
    })),
    ...item.documents.flatMap((document) => [
      ...document.versions.map((version) => ({
        id: `document-version:${version.id}`,
        date: version.createdAt,
        author: version.authorName,
        content: (
          <>
            {t(
              version.restoredFromVersionId
                ? 'deliverableDocumentVersionRestored'
                : version.number === 1
                  ? 'deliverableDocumentAdded'
                  : 'deliverableDocumentChanged',
            )}
            {' — '}
            {version.fileName} · V{version.number}
            {version.comment ? ` — ${version.comment}` : ''}
          </>
        ),
      })),
      ...(document.deletedAt !== null &&
      !(item.activityEvents ?? []).some(
        (event) =>
          event.action === 'deliverable_document_deleted' &&
          event.details.documentId === document.id,
      )
        ? [
            {
              id: `legacy-deletion:${document.id}`,
              date: document.deletedAt,
              author: null,
              content: (
                <>
                  {t('deliverableDocumentRemoved')}
                  {' — '}
                  {document.name}
                </>
              ),
            },
          ]
        : []),
    ]),
    ...item.lifecycleEvents.map((event) => ({
      id: `life:${event.id}`,
      date: event.createdAt,
      author: event.actorName,
      content: `${event.fromStatus ? t(translationKey(lifecycleStatuses[event.fromStatus])) + ' → ' : ''}${t(translationKey(lifecycleStatuses[event.toStatus]))}`,
    })),
    ...item.validationEvents.map((event) => ({
      id: `requirement:${event.id}`,
      date: event.createdAt,
      author: event.actorName,
      content: (
        <>
          {t(translationKey(validationRequirementActions[event.action]))}
          {event.reason ? ` — ${event.reason}` : ''}
        </>
      ),
    })),
    ...item.validations.flatMap((validation) => [
      {
        id: `request:${validation.id}`,
        date: validation.requestedAt,
        author: validation.requestedByName,
        content: t('submitDeliverableForValidation'),
      },
      ...(validation.decidedAt
        ? [
            {
              id: `decision:${validation.id}`,
              date: validation.decidedAt,
              author: validation.decidedByName,
              content: (
                <>
                  {t(translationKey(validationStatuses[validation.status]))}
                  {validation.decisionComment
                    ? ` — ${validation.decisionComment}`
                    : ''}
                </>
              ),
            },
          ]
        : []),
    ]),
    ...item.versions.map((version) => ({
      id: `version:${version.id}`,
      date: version.createdAt,
      author: null,
      content: (
        <>
          <strong>V{version.number}</strong> ·{' '}
          {t(
            version.status === 'validated'
              ? 'validated'
              : version.status === 'rejected'
                ? 'rejected'
                : 'awaitingValidation',
          )}{' '}
          {version.note}
          <div className="flex flex-wrap gap-2">
            {version.files.map((file, index) => (
              <Button
                key={index}
                variant="ghost"
                onClick={() => void download(version, index)}
              >
                {file.name}
              </Button>
            ))}
          </div>
        </>
      ),
    })),
  ];
  events.sort((a, b) => b.date - a.date || a.id.localeCompare(b.id));
  return (
    <section className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-left text-sm">
        <caption className="p-4 text-left font-semibold">
          {t('history')}
        </caption>
        <thead className="border-y bg-muted/40">
          <tr>
            <th className="px-4 py-2">{t('date')}</th>
            <th className="px-4 py-2">{t('author')}</th>
            <th className="px-4 py-2">{t('history')}</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id} className="border-b last:border-0">
              <td className="whitespace-nowrap px-4 py-3 align-top">
                {new Date(event.date).toLocaleString()}
              </td>
              <td className="px-4 py-3 align-top">
                {event.author ?? t('notDefined')}
              </td>
              <td className="px-4 py-3">{event.content}</td>
            </tr>
          ))}
          {!events.length && (
            <tr>
              <td colSpan={3} className="p-4 text-muted-foreground">
                {t('noSubmittedVersions')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function Links({
  item,
  board,
  base,
  busy,
  refresh,
}: {
  item: Deliverable;
  board: DeliverablesBoard;
  base: string;
  busy: boolean;
  refresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [taskId, setTaskId] = useState(item.primaryTaskId ?? '');
  const [newTaskTitle, setNewTaskTitle] = useState(item.title);
  const [openTask, setOpenTask] = useState<{
    id: string;
    resourceId: string;
  } | null>(null);
  const mainTasks = board.tasks.filter((task) => task.parentTaskId === null);
  const primaryTask = board.tasks.find(
    (task) => task.id === item.primaryTaskId,
  );
  const subtasks = board.tasks.filter(
    (task) => task.parentTaskId === item.primaryTaskId,
  );
  const link = useMutation({
    mutationFn: (primaryTaskId: string | null) =>
      projectsApi(`${base}/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ primaryTaskId, version: item.version }),
      }),
    onSuccess: () => refresh(),
  });
  const createTask = useMutation({
    mutationFn: async () => {
      const resourceId = board.taskManagers[0]?.id;
      if (!resourceId) throw new Error('No task manager');
      const result = await projectsApi<{ task: { id: string } }>(
        `/${base.split('/')[1]}/resources/${resourceId}/tasks`,
        { method: 'POST', body: JSON.stringify({ title: newTaskTitle }) },
      );
      await projectsApi(`${base}/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          primaryTaskId: result.task.id,
          version: item.version,
        }),
      });
    },
    onSuccess: () => refresh(),
  });
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div>
        <h2 className="font-semibold">{t('primaryTask')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('onePrimaryTaskPerDeliverable')}
        </p>
      </div>
      <div className="grid min-w-0 gap-4">
        <div className="min-w-0 space-y-3">
          <h3 className="font-medium">{t('primaryTask')}</h3>
          {item.primaryTaskId ? (
            <Button
              variant="outline"
              disabled={busy || link.isPending}
              onClick={() => link.mutate(null)}
            >
              {t('detachDeliverableTask')}
            </Button>
          ) : board.taskManagers.length ? (
            <>
              <div className="flex gap-2">
                <select
                  aria-label={t('primaryTask')}
                  className="min-w-0 flex-1 rounded border bg-background p-2 text-sm"
                  disabled={busy || link.isPending}
                  value={taskId}
                  onChange={(event) => setTaskId(event.target.value)}
                >
                  <option value="">{t('noPrimaryTask')}</option>
                  {mainTasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={
                    busy ||
                    link.isPending ||
                    taskId === (item.primaryTaskId ?? '')
                  }
                  onClick={() => link.mutate(taskId || null)}
                >
                  {t('associate')}
                </Button>
              </div>
              <div className="flex gap-2">
                <Input
                  aria-label={t('newTaskTitle')}
                  disabled={busy || createTask.isPending}
                  value={newTaskTitle}
                  onChange={(event) => setNewTaskTitle(event.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={
                    busy || createTask.isPending || !newTaskTitle.trim()
                  }
                  onClick={() => createTask.mutate()}
                >
                  <Plus className="h-4 w-4" />
                  {t('createTask')}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('noTaskManagerAvailable')}
            </p>
          )}
          {primaryTask && (
            <div className="min-w-0 rounded-lg border p-3 text-sm">
              <button
                type="button"
                className="block w-full rounded text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  setOpenTask({
                    id: primaryTask.id,
                    resourceId: primaryTask.resourceId,
                  })
                }
              >
                <span className="font-medium underline">
                  {primaryTask.title}
                </span>
                <span className="mt-1 block text-muted-foreground">
                  {primaryTask.status} · {primaryTask.progress}% ·{' '}
                  {primaryTask.assigneeName ?? t('unassigned')}
                </span>
              </button>
              {subtasks.length > 0 && (
                <ul className="mt-3 space-y-1 border-t pt-2">
                  {subtasks.map((task) => (
                    <li
                      key={task.id}
                      className="flex min-w-0 items-center gap-2"
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left underline"
                        title={task.title}
                        onClick={() =>
                          setOpenTask({
                            id: task.id,
                            resourceId: task.resourceId,
                          })
                        }
                      >
                        {task.title}
                      </button>
                      <span className="shrink-0 whitespace-nowrap tabular-nums">
                        {task.progress}%
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {openTask && (
            <ProjectTaskManager
              projectId={base.split('/')[1]}
              resourceId={openTask.resourceId}
              initialTaskId={openTask.id}
              modalOnly
              onModalClose={() => setOpenTask(null)}
            />
          )}
        </div>
      </div>
    </section>
  );
}
