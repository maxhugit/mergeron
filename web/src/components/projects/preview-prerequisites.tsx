import { useTranslation } from 'react-i18next';
import { translationKey } from '@/locales/translation-key';

const messages = {
  docker_version_unsupported: 'prerequisiteDockerVersion',
  manager_docker_unavailable: 'prerequisiteManagerDocker',
  application_identity_invalid: 'prerequisiteApplicationIdentity',
  workspace_mount_invalid: 'prerequisiteWorkspaceMount',
  manager_identity_invalid: 'prerequisiteManagerIdentity',
  manager_helper_volumes_unsupported: 'prerequisiteManagerVolumes',
  runtime_image_unsupported: 'prerequisiteRuntimeImageUnsupported',
  runtime_image_missing: 'prerequisiteRuntimeImageMissing',
  manager_preflight_failed: 'prerequisiteManagerPreflight',

  server_disabled: 'prerequisiteServerDisabled',
  preview_domain_missing: 'prerequisiteDomainMissing',
  viewer_not_ready: 'prerequisiteViewerNotReady',
  manager_unavailable: 'prerequisiteManagerUnavailable',
  manager_not_configured: 'prerequisiteManagerNotConfigured',
  preview_domain_mismatch: 'prerequisiteDomainMismatch',
  project_profile_missing: 'prerequisiteProfileMissing',
  project_profile_unreadable: 'prerequisiteProfileUnreadable',
  project_disabled: 'prerequisiteProjectDisabled',
  start_command_missing: 'prerequisiteStartMissing',
  agent_runtimes_missing: 'prerequisiteAgentRuntimesMissing',
  runtime_not_allowed: 'prerequisiteRuntimeNotAllowed',
  service_runtime_not_allowed: 'prerequisiteServiceRuntimeNotAllowed',
  working_directory_missing: 'prerequisiteWorkingDirectoryMissing',
  working_directory_protected: 'prerequisiteWorkingDirectoryProtected',
  working_directory_access_denied: 'prerequisiteWorkingDirectoryAccessDenied',
} as const;
export function PreviewPrerequisites({
  reasons,
  checking = false,
  failed = false,
  recipeRequired = false,
}: {
  reasons: string[];
  checking?: boolean;
  failed?: boolean;
  recipeRequired?: boolean;
}) {
  const { t } = useTranslation('previews');
  if (!reasons.length && !checking && !failed && !recipeRequired) return null;
  return (
    <section
      role={failed ? 'alert' : 'status'}
      aria-label={t('prerequisitesTitle')}
      className="space-y-2 rounded border border-amber-500/50 bg-amber-500/5 p-3 text-sm"
    >
      <h3 className="font-medium">{t('prerequisitesTitle')}</h3>
      {checking ? (
        <p>{t('prerequisitesChecking')}</p>
      ) : failed ? (
        <p>{t('prerequisitesUnavailable')}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t('prerequisitesHelp')}
          </p>
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {[...new Set(reasons)].map((reason) => (
              <li key={reason}>
                {t(
                  translationKey(
                    messages[reason as keyof typeof messages] ??
                      'prerequisiteUnknown',
                  ),
                )}
              </li>
            ))}
            {recipeRequired && <li>{t('prerequisiteRecipeRequired')}</li>}
          </ul>
        </>
      )}
    </section>
  );
}
