import { useTranslation } from 'react-i18next';
import type { ApprovalRequest } from '@/types/approval';

/** Deterministic description only; raw request details remain the authority. */
export function ApprovalPurpose({ request }: { request: ApprovalRequest }) {
  const { t, i18n } = useTranslation('workspaces');
  const tool = request.presentation?.tool;
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(tool?.argumentsJson ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      args = parsed as Record<string, unknown>;
  } catch {
    /* Explicit unavailable state below. */
  }
  const knownGit =
    request.presentation?.serverName === 'mergeron_internal' &&
    ['project_git_local_manage', 'prepare_project_git'].includes(
      tool?.name ?? '',
    );
  const goal = knownGit
    ? args.operation === 'commit'
      ? t('approvalGoalGitCommit')
      : args.operation === 'stage_review'
        ? t('approvalGoalGitReview')
        : args.operation === 'restore_files_review' ||
            args.operation === 'restore_github_review'
          ? t('approvalGoalGitRestoreReview')
          : args.operation === 'restore_files' ||
              args.operation === 'restore_github'
            ? t('approvalGoalGitRestore')
            : args.operation === 'stage'
              ? t('approvalGoalGitStage')
              : args.operation === 'unstage'
                ? t('approvalGoalGitUnstage')
                : args.operation === 'create_branch'
                  ? t('approvalGoalGitCreateBranch')
                  : args.operation === 'switch_branch'
                    ? t('approvalGoalGitSwitchBranch')
                    : args.operation === 'fetch_branch'
                      ? t('approvalGoalGitFetch')
                      : args.operation === 'start_merge'
                        ? t('approvalGoalGitMerge')
                        : args.operation === 'continue_merge'
                          ? t('approvalGoalGitContinueMerge')
                          : args.operation === 'abort_merge'
                            ? t('approvalGoalGitAbortMerge')
                            : t('approvalGoalTool')
    : request.kind === 'fileChange'
      ? t('approvalGoalFiles')
      : request.kind === 'writeStdin'
        ? t('approvalGoalTerminalInput')
        : request.kind === 'command'
          ? request.networkContext
            ? t('approvalGoalNetwork')
            : request.command
              ? t('approvalGoalCommand')
              : t('approvalGoalCommandMissing')
          : request.kind === 'permissions'
            ? t('approvalGoalPermissions')
            : tool
              ? t('approvalGoalTool')
              : t('approvalGoalInput');
  return (
    <section
      className="min-w-0 space-y-2 rounded-lg border border-border/60 bg-background/50 p-3 text-sm"
      aria-label={t('approvalPurposeTitle')}
    >
      {tool && (tool.titleFr || tool.title) && (
        <p className="font-semibold">
          {i18n.resolvedLanguage?.startsWith('fr')
            ? (tool.titleFr ?? tool.title)
            : tool.title}
        </p>
      )}
      <p className="font-medium">{goal}</p>
      {tool && (
        <>
          <p className="break-all text-xs text-muted-foreground">
            {t('approvalToolLabel')} :{' '}
            <code>{tool.name ?? t('approvalInformationMissing')}</code>
          </p>
          {tool.argumentsJson ? (
            <details className="min-w-0" open>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t('approvalArgumentsLabel')}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-2 text-xs">
                {tool.argumentsJson}
              </pre>
            </details>
          ) : (
            <p
              role="note"
              className="text-xs text-amber-700 dark:text-amber-300"
            >
              {t('approvalArgumentsMissing')}
            </p>
          )}
          {tool.description && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t('approvalToolDescriptionLabel')}
              </summary>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs">
                {tool.description}
              </p>
            </details>
          )}
        </>
      )}
      {!tool && request.kind === 'elicitation' && (
        <p className="text-xs text-muted-foreground">
          {t('approvalArgumentsMissing')}
        </p>
      )}
    </section>
  );
}
