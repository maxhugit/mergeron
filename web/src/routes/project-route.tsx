import { translationKey } from '@/locales/translation-key';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import {
  Bot,
  BrainCircuit,
  FolderCog,
  FolderKanban,
  FolderOpen,
  History,
  LayoutDashboard,
  ListTodo,
  UsersRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ProjectSettingsPanel,
  type ProjectSettingsSection,
} from '@/components/projects/project-settings-dialog';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectActivitySummary,
  type ProjectSummary,
} from '@/lib/projects-api';
import { usePlatformSession } from '@/lib/platform-session';
import { useParticipants } from '@/lib/people-api';
import {
  projectAppsQueryOptions,
  projectMcpServersQueryOptions,
} from '@/lib/project-integrations-queries';

type ProjectTab = 'general' | 'journal' | ProjectSettingsSection;

export function ProjectRoute() {
  const { projectId } = useParams({ strict: false });
  const { t, i18n } = useTranslation();
  const session = usePlatformSession();
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
  });
  const project = projects.data?.projects.find((item) => item.id === projectId);
  const [activeTab, setActiveTab] = useState<ProjectTab>('general');
  const participants = useParticipants(projectId ?? '');
  const isActiveParticipant = !!(
    session.data?.active &&
    session.data.personId &&
    participants.data?.participants.some(
      (participant) => participant.personId === session.data?.personId,
    )
  );
  const canSeePeople = session.isAdministrator || isActiveParticipant;
  const visibleTab: ProjectTab =
    (activeTab === 'participants' && !canSeePeople) ||
    (!session.isAdministrator && activeTab === 'workspaces')
      ? 'general'
      : activeTab;
  const activity = useQuery({
    queryKey: ['project-activity', projectId],
    queryFn: () =>
      projectsApi<{ activity: ProjectActivitySummary[] }>(
        `/${projectId}/activity`,
      ),
    enabled: visibleTab === 'journal',
  });

  useEffect(() => {
    if (!session.isAdministrator) return;
    void queryClient.prefetchQuery(projectMcpServersQueryOptions());
    void queryClient.prefetchQuery(projectAppsQueryOptions());
  }, [queryClient, session.isAdministrator]);

  if (projects.isPending)
    return (
      <main className="p-6 text-sm text-muted-foreground">{t('loading')}</main>
    );
  if (!project)
    return (
      <main className="p-6" role="alert">
        {t('projectNotFound')}
      </main>
    );

  const date = (value: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(
      value,
    );
  const agentCount =
    project.agentThreads?.filter((thread) => !thread.archived).length ?? 0;
  const taskBoardCount = project.resources.filter(
    (item) => item.type === 'task_board',
  ).length;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-10 min-w-0 shrink-0 items-center border-b bg-background">
        <div
          role="tablist"
          aria-label={t('projectSections')}
          className="flex min-w-0 flex-1 items-center overflow-x-auto"
        >
          <ProjectTabButton
            active={visibleTab === 'general'}
            icon={LayoutDashboard}
            label={t('generalInformation')}
            onClick={() => setActiveTab('general')}
          />
          {canSeePeople && (
            <ProjectTabButton
              active={visibleTab === 'participants'}
              icon={UsersRound}
              label={t('people')}
              onClick={() => setActiveTab('participants')}
            />
          )}
          <ProjectTabButton
            active={visibleTab === 'journal'}
            icon={History}
            label={t('journal')}
            onClick={() => setActiveTab('journal')}
          />
          <ProjectTabButton
            active={visibleTab === 'agents'}
            icon={BrainCircuit}
            label={t('agentManagement')}
            onClick={() => setActiveTab('agents')}
          />
          {session.isAdministrator && (
            <ProjectTabButton
              active={visibleTab === 'workspaces'}
              icon={FolderCog}
              label={t('workspacesLabel')}
              onClick={() => setActiveTab('workspaces')}
            />
          )}
        </div>
      </div>

      <div
        className={`min-h-0 flex-1 p-4 md:p-6 ${visibleTab === 'journal' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}
      >
        <div
          className={`mx-auto w-full max-w-6xl ${visibleTab === 'journal' ? 'flex min-h-0 flex-1 flex-col' : 'space-y-6'}`}
        >
          {visibleTab === 'general' ? (
            <>
              <section className="rounded-xl border bg-card p-5">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-primary/10 p-2 text-primary">
                    <FolderKanban className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="truncate text-xl font-semibold">
                      {project.name}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('generalProjectInformationAndLinkedResources')}
                    </p>
                  </div>
                </div>
              </section>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryCard
                  icon={FolderOpen}
                  label={t('workspacesLabel')}
                  value={project.workspaces.length}
                />
                <SummaryCard
                  icon={Bot}
                  label={t('workAgents')}
                  value={agentCount}
                />
                <SummaryCard
                  icon={ListTodo}
                  label={t('taskManagers')}
                  value={taskBoardCount}
                />
                <SummaryCard
                  icon={FolderKanban}
                  label={t('resources')}
                  value={project.resources.length}
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <section className="rounded-xl border bg-card p-5">
                  <h3 className="font-semibold">{t('projectWorkspaces')}</h3>
                  <div className="mt-4 space-y-2">
                    {project.workspaces.map((workspace) => (
                      <div
                        key={workspace.id}
                        className="flex items-center gap-3 rounded-lg border p-3"
                      >
                        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {workspace.name}
                          </p>
                          <p
                            className="truncate text-xs text-muted-foreground"
                            title={workspace.path}
                          >
                            {workspace.path}
                          </p>
                        </div>
                        {workspace.primary && (
                          <span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">
                            {t('primaryWorkspace')}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-xl border bg-card p-5">
                  <h3 className="font-semibold">{t('details')}</h3>
                  <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">{t('created')}</dt>
                      <dd className="mt-1 font-medium">
                        {date(project.createdAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        {t('lastModified')}
                      </dt>
                      <dd className="mt-1 font-medium">
                        {date(project.updatedAt)}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-muted-foreground">
                        {t('primaryWorkspace')}
                      </dt>
                      <dd className="mt-1 break-all font-medium">
                        {project.workspacePath}
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
            </>
          ) : visibleTab === 'journal' ? (
            <ProjectJournal
              rows={activity.data?.activity ?? []}
              pending={activity.isPending}
              error={activity.isError}
              locale={i18n.language}
              t={t}
            />
          ) : (
            <ProjectSettingsPanel
              key={`${project.id}:${project.updatedAt}:${visibleTab}`}
              project={project}
              section={visibleTab}
              canManageParticipants={session.isAdministrator}
            />
          )}
        </div>
      </div>
    </main>
  );
}

function ProjectTabButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof LayoutDashboard;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`flex h-10 shrink-0 cursor-pointer items-center gap-2 border-b-2 px-3 text-xs transition-colors hover:bg-accent/50 ${active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'}`}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}

function ProjectJournal({
  rows,
  pending,
  error,
  locale,
  t,
}: {
  rows: ProjectActivitySummary[];
  pending: boolean;
  error: boolean;
  locale: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [actorFilter, setActorFilter] = useState('all');
  const labels: Record<string, string> = {
    project_created: 'Project created',
    project_renamed: 'Project renamed',
    workspace_added: 'Workspace added',
    workspace_default_changed: 'Default workspace changed',
    workspace_detached: 'Workspace detached',
    participant_added: 'Participant added',
    participant_removed: 'Participant removed',
    resource_created: 'Resource created',
    resource_updated: 'Resource updated',
    resource_deleted: 'Resource deleted',
    resource_moved_out: 'Resource moved to another project',
    resource_moved_in: 'Resource moved into the project',
    mcp_configuration_updated: 'MCP connector configuration updated',
    app_configuration_updated: 'App configuration updated',
    agent_configuration_updated: 'Agent configuration updated',
  };
  const actorOptions = Array.from(
    new Map(
      rows.map((row) => [
        activityActorKey(row.actorPersonId, row.actorName),
        row.actorName,
      ]),
    ),
  );
  const filteredRows =
    actorFilter === 'all'
      ? rows
      : rows.filter(
          (row) =>
            activityActorKey(row.actorPersonId, row.actorName) === actorFilter,
        );
  if (pending)
    return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  if (error)
    return (
      <p className="text-sm text-destructive">
        {t('unableToLoadProjectActivity')}
      </p>
    );
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex shrink-0 flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-semibold">{t('projectJournal')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('majorOperationsPerformedOnThisProjectAreRecordedHere')}
          </p>
        </div>
        {rows.length > 0 && (
          <label className="shrink-0">
            <span className="sr-only">{t('filterByPerson')}</span>
            <select
              value={actorFilter}
              onChange={(event) => setActorFilter(event.target.value)}
              className="h-9 min-w-48 cursor-pointer rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <option value="all">{t('allPeople')}</option>
              {actorOptions.map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div
        role="region"
        aria-label={t('projectJournal')}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
      >
        {rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {t('noProjectActivityYet')}
          </p>
        ) : filteredRows.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {t('noActivityForThisPerson')}
          </p>
        ) : (
          <div className="divide-y">
            {filteredRows.map((row) => {
              const changes = projectActivityChanges(row.details);
              return (
                <div
                  key={row.id}
                  className="grid gap-3 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {t(translationKey(labels[row.action] ?? row.action))}
                    </p>
                    <p
                      className="truncate text-xs text-muted-foreground"
                      title={row.label}
                    >
                      {row.label}
                    </p>
                    {changes.length > 0 && (
                      <div className="mt-2 space-y-1 text-xs">
                        {changes.map((change) => (
                          <div
                            key={change.label}
                            className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]"
                          >
                            <span className="font-medium">
                              {t(translationKey(change.label))}
                            </span>
                            <span className="break-words text-muted-foreground">
                              <span className="line-through opacity-70">
                                {formatActivityValue(change.before)}
                              </span>{' '}
                              →{' '}
                              <span className="text-foreground">
                                {formatActivityValue(change.after)}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground sm:text-right">
                    <p>
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(row.createdAt)}
                    </p>
                    <p>{t('byName', { name: row.actorName })}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function activityActorKey(actorPersonId: string | null, actorName: string) {
  return actorPersonId ? `person:${actorPersonId}` : `system:${actorName}`;
}

function projectActivityChanges(details: Record<string, unknown>) {
  const labels: Record<string, string> = {
    model: 'Model',
    reasoningEffort: 'Reasoning effort',
    name: 'Project name',
    connectors: 'MCP connectors',
    applications: 'Applications',
    defaultWorkspace: 'Default workspace',
  };
  const result: Array<{ label: string; before: unknown; after: unknown }> = [];
  if ('before' in details || 'after' in details) {
    result.push({
      label: labels.name,
      before: details.before,
      after: details.after,
    });
  }
  if ('beforeName' in details || 'afterName' in details) {
    result.push({
      label: labels.name,
      before: details.beforeName,
      after: details.afterName,
    });
  }
  for (const [key, value] of Object.entries(details)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      ('before' in value || 'after' in value)
    ) {
      const change = value as { before?: unknown; after?: unknown };
      result.push({
        label: labels[key] ?? key,
        before: change.before,
        after: change.after,
      });
    }
  }
  if (Array.isArray(details.before) || Array.isArray(details.after)) {
    return [
      {
        label:
          details.before === undefined && details.after === undefined
            ? 'Configuration'
            : 'Selection',
        before: details.before,
        after: details.after,
      },
    ];
  }
  return result;
}

function formatActivityValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ') || '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof FolderKanban;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-3 text-muted-foreground">
        <span className="text-sm">{label}</span>
        <Icon className="h-4 w-4" />
      </div>
      <p className="mt-3 text-2xl font-semibold">{value}</p>
    </div>
  );
}
