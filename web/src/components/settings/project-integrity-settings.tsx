import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ChevronRight,
  ArrowUpRight,
} from 'lucide-react';
import { withBasePath } from '@/base-path';
import { usePlatformSession } from '@/lib/platform-session';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
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
  type IntegrityReport,
  type IntegrityIssue,
} from './project-integrity-api';

import {
  IntegrityIssueTitle,
  IntegrityDiagram,
  IntegrityExplanation,
} from './project-integrity-diagram';

const contextKeys = {
  agent: 'context.agent',
  task: 'context.task',
  deliverable: 'context.deliverable',
  simple_chat: 'context.simpleChat',
} as const;
const issueKindKeys: Record<string, string> = {
  'outside-project': 'kind.outsideProject',
  'symbolic-link': 'kind.symbolicLink',
  'path-collision': 'kind.pathCollision',
  'project-root-missing': 'kind.projectRootMissing',
  'project-location-mismatch': 'kind.projectLocationMismatch',
  'migration-required': 'kind.migrationRequired',
  'project-identity-mismatch': 'kind.projectIdentityMismatch',
  'directory-missing': 'kind.directoryMissing',
  'document-missing': 'kind.documentMissing',
  'current-version-missing': 'kind.currentVersionMissing',
  'snapshot-missing': 'kind.snapshotMissing',
  'document-location-mismatch': 'kind.documentLocationMismatch',
  'snapshot-location-mismatch': 'kind.snapshotLocationMismatch',
  'copy-registration-missing': 'kind.copyRegistrationMissing',
  'copy-location-mismatch': 'kind.copyLocationMismatch',
  'copy-missing': 'kind.copyMissing',
  'git-metadata-missing': 'kind.gitMetadataMissing',
  'agent-reference-obsolete': 'kind.agentReferenceObsolete',
  'agent-override-obsolete': 'kind.agentOverrideObsolete',
  'agent-reference-missing': 'kind.agentReferenceMissing',
  'unregistered-document': 'kind.unregisteredDocument',
  'unregistered-deliverable-directory': 'kind.unregisteredDeliverableDirectory',
  'unregistered-copy': 'kind.unregisteredCopy',
  'scan-limited': 'kind.scanLimited',
  'transfer-running': 'kind.transferRunning',
  'primary-location-mismatch': 'kind.primaryLocationMismatch',
  'active-folder-registration-missing': 'kind.activeFolderRegistrationMissing',
  'active-folder-outside-workspace': 'kind.activeFolderOutsideWorkspace',
  'active-folder-missing': 'kind.activeFolderMissing',
};
const issueHelpKeys: Record<string, string> = {
  'active-folder-registration-missing': 'help.activeFolderRegistrationMissing',
  'unregistered-copy': 'help.unregisteredCopy',
  'unregistered-document': 'help.unregisteredDocument',
  'copy-missing': 'help.copyMissing',
  'document-missing': 'help.documentMissing',
  'scan-limited': 'help.scanLimited',
  'directory-missing': 'help.directoryMissing',
  'agent-reference-obsolete': 'help.agentReferenceObsolete',
  'agent-override-obsolete': 'help.agentOverrideObsolete',
};

export function ProjectIntegritySettings() {
  const { t } = useTranslation('integrity');
  const session = usePlatformSession();
  const client = useQueryClient();
  const [projectId, setProjectId] = useState('');
  const [preview, setPreview] = useState(false);
  const [selected, setSelected] = useState<{
    projectId: string;
    issueId: string;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    report: IntegrityReport;
    issue: IntegrityIssue;
  } | null>(null);
  const projects = useQuery({
    queryKey: ['project-integrity', 'projects'],
    queryFn: () =>
      integrityRequest<{ projects: { id: string; name: string }[] }>(),
    enabled: session.isAdministrator,
    retry: false,
  });
  const report = useQuery({
    queryKey: ['project-integrity', projectId],
    queryFn: () =>
      integrityRequest<IntegrityReport>('/' + encodeURIComponent(projectId)),
    enabled: session.isAdministrator && !!projectId,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const repair = useMutation({
    mutationFn: ({ report, issue }: NonNullable<typeof confirmation>) =>
      integrityRequest<IntegrityReport>(
        '/' + encodeURIComponent(report.projectId) + '/repair',
        {
          fingerprint: report.fingerprint,
          issueId: issue.id,
          confirmation: 'REPAIR_PROJECT',
        },
      ),
    onSuccess: (next) => {
      client.setQueryData(['project-integrity', next.projectId], next);
      setConfirmation(null);
    },
    onError: () => {
      setConfirmation(null);
      void report.refetch();
    },
  });
  const selectedReport =
    selected?.projectId === report.data?.projectId ? report.data : undefined;
  const selectedIssue = selectedReport?.issues.find(
    (issue) => issue.id === selected?.issueId,
  );
  const actionLabels = {
    'create-directory': 'createDirectory',
    'realign-agent': 'realign',
    'realign-override': 'realign',
    'select-project-folder': 'selectProjectFolder',
  };
  const actionDescriptions = {
    'create-directory': 'confirmDirectory',
    'realign-agent': 'confirmReference',
    'realign-override': 'confirmReference',
    'select-project-folder': 'confirmProjectFolder',
  };
  const selectedAction =
    !selectedReport?.limited &&
    selectedIssue?.action &&
    Object.hasOwn(actionLabels, selectedIssue.action)
      ? selectedIssue.action
      : null;
  const agentId =
    selectedIssue?.reference?.contextType === 'agent'
      ? selectedIssue.reference.contextId
      : selectedIssue?.kind === 'agent-reference-obsolete'
        ? selectedIssue.entityId
        : null;
  if (!session.isAdministrator) return <p role="alert">{t('administrator')}</p>;
  return (
    <section className="min-w-0 space-y-4">
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <label className="block space-y-2">
        <span>{t('project')}</span>
        <select
          className="w-full rounded border bg-background p-2"
          value={projectId}
          disabled={repair.isPending}
          onChange={(e) => {
            setProjectId(e.target.value);
            setSelected(null);
            setPreview(false);
            setConfirmation(null);
            repair.reset();
          }}
        >
          <option value="">{t('choose')}</option>
          {projects.data?.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {projects.isError && <p role="alert">{t('failed')}</p>}
      <Button
        variant="outline"
        disabled={!projectId || report.isFetching || repair.isPending}
        onClick={() => {
          repair.reset();
          void report.refetch();
        }}
      >
        <RefreshCw className="mr-2 h-4 w-4" />
        {t('scan')}
      </Button>
      {report.isFetching && <p role="status">{t('scanning')}</p>}
      {report.isError && <p role="alert">{t('failed')}</p>}
      {repair.isError && (
        <p role="alert" className="text-destructive">
          {t(repair.error.message === 'changed' ? 'changed' : 'repairFailed')}
        </p>
      )}
      {report.data && !report.isError && (
        <>
          <p className="break-all text-xs text-muted-foreground">
            {report.data.root}
          </p>
          <p className="text-sm">{t('counts', report.data.counts)}</p>
          <p className="text-xs text-muted-foreground">
            {t('observed', {
              date: new Date(report.data.inspectedAt).toLocaleString(),
            })}
          </p>
          {!report.data.issues.length && !report.data.limited && (
            <p
              role="status"
              className="flex items-center gap-2 rounded border border-emerald-500 p-4 text-emerald-600"
            >
              <CheckCircle2 />
              {t('healthy')}
            </p>
          )}
          {report.data.issues.map((issue) => (
            <article
              key={issue.id}
              className="relative min-w-0 space-y-2 rounded-lg border p-3 hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring"
            >
              <h3 className="font-medium">
                <button
                  type="button"
                  aria-haspopup="dialog"
                  className="flex w-full items-start gap-2 text-left after:absolute after:inset-0 after:rounded-lg focus:outline-none"
                  aria-label={t('viewCorrectionsFor', {
                    issue: t(issueKindKeys[issue.kind] ?? 'unknown'),
                    target: issue.reference?.label ?? issue.path,
                  })}
                  onClick={() => {
                    setPreview(false);
                    setSelected({
                      projectId: report.data!.projectId,
                      issueId: issue.id,
                    });
                  }}
                >
                  <AlertTriangle
                    className={
                      issue.severity === 'error'
                        ? 'shrink-0 text-destructive'
                        : 'shrink-0 text-amber-500'
                    }
                  />
                  <IntegrityIssueTitle kind={issue.kind} />
                </button>
              </h3>
              {issue.reference && (
                <p className="break-words text-sm font-medium">
                  {t(contextKeys[issue.reference.contextType] ?? 'unknown')} :{' '}
                  {issue.reference.label}
                </p>
              )}
              <IntegrityDiagram issue={issue} />
              <IntegrityExplanation kind={issue.kind} />
              <span className="inline-flex items-center gap-1 text-xs text-primary">
                {t('viewCorrections')}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </article>
          ))}
        </>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
          style={{ background: 'var(--popover)' }}
        >
          <DialogTitle className="pr-7">{t('correctionsTitle')}</DialogTitle>
          <DialogDescription>{t('correctionsIntro')}</DialogDescription>
          {selectedIssue ? (
            <>
              <h3 className="font-medium">
                <IntegrityIssueTitle kind={selectedIssue.kind} />
              </h3>
              {selectedIssue.reference && (
                <p className="break-words text-sm">
                  {t(
                    contextKeys[selectedIssue.reference.contextType] ??
                      'unknown',
                  )}{' '}
                  : {selectedIssue.reference.label}
                </p>
              )}
              {selectedAction && (
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label={t('correctionsTitle')}
                >
                  <Button
                    variant={preview ? 'outline' : 'default'}
                    aria-pressed={!preview}
                    onClick={() => setPreview(false)}
                  >
                    {t('visual.current')}
                  </Button>
                  <Button
                    variant={preview ? 'default' : 'outline'}
                    aria-pressed={preview}
                    onClick={() => setPreview(true)}
                  >
                    {t('visual.after')}
                  </Button>
                </div>
              )}
              <IntegrityDiagram
                issue={selectedIssue}
                preview={preview && !!selectedAction}
              />
              {preview && selectedAction ? (
                <div className="space-y-2" role="status">
                  <h4 className="font-medium">{t('visual.afterLabel')}</h4>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      actionDescriptions[selectedAction] ?? 'confirmReference',
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('visual.beforeConfirm')}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <h4 className="font-medium">{t('visual.explanation')}</h4>
                  <IntegrityExplanation kind={selectedIssue.kind} />
                  <p className="text-sm text-muted-foreground">
                    {t(issueHelpKeys[selectedIssue.kind] ?? 'manual')}
                  </p>
                </div>
              )}
              <details className="min-w-0 space-y-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                <summary className="cursor-pointer py-2">
                  {t('visual.details')}
                </summary>
                <p>{t(issueKindKeys[selectedIssue.kind] ?? 'unknown')}</p>
                {selectedIssue.reference && (
                  <>
                    <p>
                      {t('missingConnection', {
                        id: selectedIssue.reference.resourceId,
                      })}
                    </p>
                    <p>{selectedIssue.reference.relativePath}</p>
                  </>
                )}
                <p>{selectedIssue.path}</p>
                {selectedIssue.expectedPath && (
                  <p>
                    {t('expected')}: {selectedIssue.expectedPath}
                  </p>
                )}
              </details>
              <h4 className="font-medium">{t('availableCorrections')}</h4>
              {selectedReport?.limited && (
                <p role="alert" className="text-sm text-muted-foreground">
                  {t('help.scanLimited')}
                </p>
              )}
              {selectedAction ? (
                <ul>
                  <li>
                    <Button
                      variant="outline"
                      aria-label={t(actionLabels[selectedAction] ?? 'realign')}
                      aria-describedby="integrity-repair-help"
                      className="h-auto w-full flex-col items-start whitespace-normal p-3 text-left"
                      disabled={
                        repair.isPending || report.isFetching || report.isError
                      }
                      onClick={() => {
                        if (!selectedReport) return;
                        setSelected(null);
                        setConfirmation({
                          report: selectedReport,
                          issue: selectedIssue,
                        });
                      }}
                    >
                      <span className="font-medium">
                        {t(actionLabels[selectedAction] ?? 'realign')}
                      </span>
                      <span
                        id="integrity-repair-help"
                        className="text-xs font-normal text-muted-foreground"
                      >
                        {t(
                          actionDescriptions[selectedAction] ??
                            'confirmReference',
                        )}
                      </span>
                    </Button>
                  </li>
                </ul>
              ) : (
                <p className="rounded-lg bg-muted p-3 text-sm">
                  {t('noAutomaticRepair')}
                </p>
              )}
              {agentId && (
                <Button
                  asChild
                  variant="outline"
                  className="h-auto justify-start whitespace-normal"
                >
                  <a href={withBasePath(`/t/${encodeURIComponent(agentId)}`)}>
                    <ArrowUpRight className="h-4 w-4 shrink-0" />
                    {t('openAgentReference')}
                  </a>
                </Button>
              )}
            </>
          ) : (
            <p role="status">
              {t(report.isError ? 'failed' : 'issueResolved')}
            </p>
          )}
          {report.isFetching && <p role="status">{t('scanning')}</p>}
          {report.isError && selectedIssue && <p role="alert">{t('failed')}</p>}
          <Button
            variant="outline"
            disabled={report.isFetching || repair.isPending}
            onClick={() => void report.refetch()}
          >
            <RefreshCw className="h-4 w-4" />
            {t('scan')}
          </Button>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !repair.isPending) setConfirmation(null);
        }}
      >
        <AlertDialogContent
          className="max-h-[85dvh] overflow-y-auto"
          style={{ background: 'var(--popover)' }}
        >
          <AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              confirmation?.issue.action === 'select-project-folder'
                ? 'confirmProjectFolder'
                : confirmation?.issue.action === 'create-directory'
                  ? 'confirmDirectory'
                  : 'confirmReference',
            )}
          </AlertDialogDescription>
          {confirmation && (
            <IntegrityDiagram issue={confirmation.issue} preview />
          )}
          <p className="break-all text-xs">
            {confirmation?.issue.reference?.label ?? confirmation?.issue.path}
          </p>
          {confirmation?.issue.expectedPath && (
            <p className="break-all text-xs">
              {confirmation.issue.expectedPath}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={repair.isPending}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={repair.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (confirmation) repair.mutate(confirmation);
              }}
            >
              {t('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
