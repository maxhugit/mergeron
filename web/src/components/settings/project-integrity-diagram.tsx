import { useTranslation } from 'react-i18next';
import {
  Folder,
  FolderCheck,
  FileQuestion,
  Link2,
  ArrowRight,
  TriangleAlert,
} from 'lucide-react';
import type { IntegrityIssue } from './project-integrity-api';

const integrityVisuals: Record<
  string,
  {
    title: string;
    left: string;
    right: string;
    link: string;
    explanation: string;
  }
> = {
  'outside-project': {
    title: 'visual.outsideProject.title',
    left: 'visual.outsideProject.left',
    right: 'visual.outsideProject.right',
    link: 'visual.outsideProject.link',
    explanation: 'visual.outsideProject.explanation',
  },
  'symbolic-link': {
    title: 'visual.symbolicLink.title',
    left: 'visual.symbolicLink.left',
    right: 'visual.symbolicLink.right',
    link: 'visual.symbolicLink.link',
    explanation: 'visual.symbolicLink.explanation',
  },
  'path-collision': {
    title: 'visual.pathCollision.title',
    left: 'visual.pathCollision.left',
    right: 'visual.pathCollision.right',
    link: 'visual.pathCollision.link',
    explanation: 'visual.pathCollision.explanation',
  },
  'project-root-missing': {
    title: 'visual.projectRootMissing.title',
    left: 'visual.projectRootMissing.left',
    right: 'visual.projectRootMissing.right',
    link: 'visual.projectRootMissing.link',
    explanation: 'visual.projectRootMissing.explanation',
  },
  'project-location-mismatch': {
    title: 'visual.projectLocationMismatch.title',
    left: 'visual.projectLocationMismatch.left',
    right: 'visual.projectLocationMismatch.right',
    link: 'visual.projectLocationMismatch.link',
    explanation: 'visual.projectLocationMismatch.explanation',
  },
  'migration-required': {
    title: 'visual.migrationRequired.title',
    left: 'visual.migrationRequired.left',
    right: 'visual.migrationRequired.right',
    link: 'visual.migrationRequired.link',
    explanation: 'visual.migrationRequired.explanation',
  },
  'project-identity-mismatch': {
    title: 'visual.projectIdentityMismatch.title',
    left: 'visual.projectIdentityMismatch.left',
    right: 'visual.projectIdentityMismatch.right',
    link: 'visual.projectIdentityMismatch.link',
    explanation: 'visual.projectIdentityMismatch.explanation',
  },
  'directory-missing': {
    title: 'visual.directoryMissing.title',
    left: 'visual.directoryMissing.left',
    right: 'visual.directoryMissing.right',
    link: 'visual.directoryMissing.link',
    explanation: 'visual.directoryMissing.explanation',
  },
  'document-missing': {
    title: 'visual.documentMissing.title',
    left: 'visual.documentMissing.left',
    right: 'visual.documentMissing.right',
    link: 'visual.documentMissing.link',
    explanation: 'visual.documentMissing.explanation',
  },
  'current-version-missing': {
    title: 'visual.currentVersionMissing.title',
    left: 'visual.currentVersionMissing.left',
    right: 'visual.currentVersionMissing.right',
    link: 'visual.currentVersionMissing.link',
    explanation: 'visual.currentVersionMissing.explanation',
  },
  'snapshot-missing': {
    title: 'visual.snapshotMissing.title',
    left: 'visual.snapshotMissing.left',
    right: 'visual.snapshotMissing.right',
    link: 'visual.snapshotMissing.link',
    explanation: 'visual.snapshotMissing.explanation',
  },
  'document-location-mismatch': {
    title: 'visual.documentLocationMismatch.title',
    left: 'visual.documentLocationMismatch.left',
    right: 'visual.documentLocationMismatch.right',
    link: 'visual.documentLocationMismatch.link',
    explanation: 'visual.documentLocationMismatch.explanation',
  },
  'snapshot-location-mismatch': {
    title: 'visual.snapshotLocationMismatch.title',
    left: 'visual.snapshotLocationMismatch.left',
    right: 'visual.snapshotLocationMismatch.right',
    link: 'visual.snapshotLocationMismatch.link',
    explanation: 'visual.snapshotLocationMismatch.explanation',
  },
  'copy-registration-missing': {
    title: 'visual.copyRegistrationMissing.title',
    left: 'visual.copyRegistrationMissing.left',
    right: 'visual.copyRegistrationMissing.right',
    link: 'visual.copyRegistrationMissing.link',
    explanation: 'visual.copyRegistrationMissing.explanation',
  },
  'copy-location-mismatch': {
    title: 'visual.copyLocationMismatch.title',
    left: 'visual.copyLocationMismatch.left',
    right: 'visual.copyLocationMismatch.right',
    link: 'visual.copyLocationMismatch.link',
    explanation: 'visual.copyLocationMismatch.explanation',
  },
  'copy-missing': {
    title: 'visual.copyMissing.title',
    left: 'visual.copyMissing.left',
    right: 'visual.copyMissing.right',
    link: 'visual.copyMissing.link',
    explanation: 'visual.copyMissing.explanation',
  },
  'git-metadata-missing': {
    title: 'visual.gitMetadataMissing.title',
    left: 'visual.gitMetadataMissing.left',
    right: 'visual.gitMetadataMissing.right',
    link: 'visual.gitMetadataMissing.link',
    explanation: 'visual.gitMetadataMissing.explanation',
  },
  'agent-reference-obsolete': {
    title: 'visual.agentReferenceObsolete.title',
    left: 'visual.agentReferenceObsolete.left',
    right: 'visual.agentReferenceObsolete.right',
    link: 'visual.agentReferenceObsolete.link',
    explanation: 'visual.agentReferenceObsolete.explanation',
  },
  'agent-override-obsolete': {
    title: 'visual.agentOverrideObsolete.title',
    left: 'visual.agentOverrideObsolete.left',
    right: 'visual.agentOverrideObsolete.right',
    link: 'visual.agentOverrideObsolete.link',
    explanation: 'visual.agentOverrideObsolete.explanation',
  },
  'agent-reference-missing': {
    title: 'visual.agentReferenceMissing.title',
    left: 'visual.agentReferenceMissing.left',
    right: 'visual.agentReferenceMissing.right',
    link: 'visual.agentReferenceMissing.link',
    explanation: 'visual.agentReferenceMissing.explanation',
  },
  'unregistered-document': {
    title: 'visual.unregisteredDocument.title',
    left: 'visual.unregisteredDocument.left',
    right: 'visual.unregisteredDocument.right',
    link: 'visual.unregisteredDocument.link',
    explanation: 'visual.unregisteredDocument.explanation',
  },
  'unregistered-deliverable-directory': {
    title: 'visual.unregisteredDeliverableDirectory.title',
    left: 'visual.unregisteredDeliverableDirectory.left',
    right: 'visual.unregisteredDeliverableDirectory.right',
    link: 'visual.unregisteredDeliverableDirectory.link',
    explanation: 'visual.unregisteredDeliverableDirectory.explanation',
  },
  'unregistered-copy': {
    title: 'visual.unregisteredCopy.title',
    left: 'visual.unregisteredCopy.left',
    right: 'visual.unregisteredCopy.right',
    link: 'visual.unregisteredCopy.link',
    explanation: 'visual.unregisteredCopy.explanation',
  },
  'scan-limited': {
    title: 'visual.scanLimited.title',
    left: 'visual.scanLimited.left',
    right: 'visual.scanLimited.right',
    link: 'visual.scanLimited.link',
    explanation: 'visual.scanLimited.explanation',
  },
  'transfer-running': {
    title: 'visual.transferRunning.title',
    left: 'visual.transferRunning.left',
    right: 'visual.transferRunning.right',
    link: 'visual.transferRunning.link',
    explanation: 'visual.transferRunning.explanation',
  },
  'primary-location-mismatch': {
    title: 'visual.primaryLocationMismatch.title',
    left: 'visual.primaryLocationMismatch.left',
    right: 'visual.primaryLocationMismatch.right',
    link: 'visual.primaryLocationMismatch.link',
    explanation: 'visual.primaryLocationMismatch.explanation',
  },
  'active-folder-registration-missing': {
    title: 'visual.activeFolderRegistrationMissing.title',
    left: 'visual.activeFolderRegistrationMissing.left',
    right: 'visual.activeFolderRegistrationMissing.right',
    link: 'visual.activeFolderRegistrationMissing.link',
    explanation: 'visual.activeFolderRegistrationMissing.explanation',
  },
  'active-folder-outside-workspace': {
    title: 'visual.activeFolderOutsideWorkspace.title',
    left: 'visual.activeFolderOutsideWorkspace.left',
    right: 'visual.activeFolderOutsideWorkspace.right',
    link: 'visual.activeFolderOutsideWorkspace.link',
    explanation: 'visual.activeFolderOutsideWorkspace.explanation',
  },
  'active-folder-missing': {
    title: 'visual.activeFolderMissing.title',
    left: 'visual.activeFolderMissing.left',
    right: 'visual.activeFolderMissing.right',
    link: 'visual.activeFolderMissing.link',
    explanation: 'visual.activeFolderMissing.explanation',
  },
};

export function IntegrityIssueTitle({ kind }: { kind: string }) {
  const { t } = useTranslation('integrity');
  return <>{t(integrityVisuals[kind]?.title ?? 'visual.unknown.title')}</>;
}

export function IntegrityExplanation({ kind }: { kind: string }) {
  const { t } = useTranslation('integrity');
  return (
    <p className="text-sm text-muted-foreground">
      {t(integrityVisuals[kind]?.explanation ?? 'visual.unknown.explanation')}
    </p>
  );
}

export function IntegrityDiagram({
  issue,
  preview = false,
}: {
  issue: IntegrityIssue;
  preview?: boolean;
}) {
  const { t } = useTranslation('integrity');
  const profile = integrityVisuals[issue.kind];
  const supported =
    issue.action === 'create-directory' ||
    issue.action === 'realign-agent' ||
    issue.action === 'realign-override' ||
    issue.action === 'select-project-folder';
  const after = preview && supported;
  const leftProblem = [
    'unregistered-document',
    'unregistered-deliverable-directory',
    'unregistered-copy',
  ].includes(issue.kind);
  const problemClass =
    'border border-dashed border-amber-500/70 bg-amber-500/10 text-amber-800 dark:text-amber-300';
  const nodeClass =
    'flex min-h-16 min-w-0 items-center gap-2 rounded-md p-2 sm:p-3';
  const left = t(profile?.left ?? 'visual.unknown.left');
  const right = after
    ? t(
        issue.action === 'create-directory'
          ? 'visual.created'
          : 'visual.linked',
      )
    : t(profile?.right ?? 'visual.unknown.right');
  const link = after
    ? t(
        issue.action === 'create-directory'
          ? 'visual.createdLink'
          : 'visual.linkedLink',
      )
    : t(profile?.link ?? 'visual.unknown.link');
  return (
    <div
      role="img"
      aria-label={t('visual.diagram', { left, link, right })}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_5rem_minmax(0,1fr)] items-center gap-2 text-xs [overflow-wrap:anywhere] sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)]"
    >
      <div
        className={`${nodeClass} ${!after && leftProblem ? problemClass : 'bg-muted'}`}
      >
        <Folder
          className="hidden h-4 w-4 shrink-0 sm:block"
          aria-hidden="true"
        />
        <span>{left}</span>
      </div>
      <div
        className={`flex min-w-0 flex-col items-center gap-1 text-center ${after ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}
      >
        <span className="flex items-center gap-1" aria-hidden="true">
          {after ? (
            <Link2 className="h-4 w-4" />
          ) : (
            <TriangleAlert className="h-4 w-4" />
          )}
          <ArrowRight className="h-4 w-4" />
        </span>
        <span>{link}</span>
      </div>
      <div
        className={`${nodeClass} ${after ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' : !leftProblem ? problemClass : 'bg-muted'}`}
      >
        {after ? (
          <FolderCheck
            className="hidden h-4 w-4 shrink-0 sm:block"
            aria-hidden="true"
          />
        ) : (
          <FileQuestion
            className="hidden h-4 w-4 shrink-0 sm:block"
            aria-hidden="true"
          />
        )}
        <span>{right}</span>
      </div>
    </div>
  );
}
