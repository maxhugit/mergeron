import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { usePlatformSession } from '@/lib/platform-session';
import { Button } from '@/components/ui/button';
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
              className="min-w-0 space-y-2 rounded-lg border p-3"
            >
              <h3 className="flex items-center gap-2 font-medium">
                <AlertTriangle
                  className={
                    issue.severity === 'error'
                      ? 'shrink-0 text-destructive'
                      : 'shrink-0 text-amber-500'
                  }
                />
                {t(issueKindKeys[issue.kind] ?? 'unknown')}
              </h3>
              <p className="break-all text-xs">{issue.path}</p>
              {issue.expectedPath && (
                <p className="break-all text-xs">
                  {t('expected')}: {issue.expectedPath}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {t(issueHelpKeys[issue.kind] ?? 'manual')}
              </p>
              {issue.action && (
                <Button
                  variant="outline"
                  disabled={repair.isPending || report.isFetching}
                  onClick={() =>
                    setConfirmation({ report: report.data!, issue })
                  }
                >
                  {t(
                    issue.action === 'create-directory'
                      ? 'createDirectory'
                      : 'realign',
                  )}
                </Button>
              )}
            </article>
          ))}
        </>
      )}
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !repair.isPending) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              confirmation?.issue.action === 'create-directory'
                ? 'confirmDirectory'
                : 'confirmReference',
            )}
          </AlertDialogDescription>
          <p className="break-all text-xs">{confirmation?.issue.path}</p>
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
