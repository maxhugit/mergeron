import { translationKey } from '@/locales/translation-key';
/**
 * Security policy selector for the composer, scoped to THIS conversation.
 *
 * It used to read and write the global config and promise that changes
 * hot-reloaded into every active thread. Measured against the pinned
 * app-server, that promise was false: writing the global keys with the reload
 * flag changed the default for threads started afterwards while the loaded
 * thread stayed exactly as it was. It also explained the "unknown / unknown"
 * display — the global file simply has no explicit value for those keys, which
 * says nothing about what the conversation is running under.
 *
 * The global default for new conversations is edited in Settings, where it
 * belongs. This control changes one conversation, and says so.
 */
import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useThreadSecurityPolicy } from '@/hooks/use-thread-security-policy';
import type {
  PatchThreadSecurityPolicyDto,
  ThreadSecurityPolicyDto,
} from '@/generated/api';
import { sandboxMode } from '@/stores/thread-policy-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { cn } from '@/lib/utils';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import {
  projectForWorkspace,
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';

// Codex CLI >= 0.149.0 retired `untrusted` and `on-failure`; selecting either
// would write a value the app-server rejects.
const APPROVAL_OPTIONS = ['on-request', 'never'] as const;

type SandboxPatch = NonNullable<PatchThreadSecurityPolicyDto['sandboxPolicy']>;

/**
 * Builds the sandbox variants this picker offers.
 *
 * The endpoint deliberately does not synthesize roots or network access, so
 * every field has to mean something here. `writableRoots` contains additional
 * roots: the conversation cwd is already writable implicitly in
 * `workspaceWrite`. Repeating the cwd here makes the request differ from the
 * canonical policy reported back by app-server (`writableRoots: []`) and used
 * to produce a false "did not take effect" error. We still require a known cwd
 * before offering workspace-write, because it is the implicit writable root.
 *
 * Network access carries over from whatever is currently in force, because this
 * control is about the sandbox mode; silently flipping the network alongside it
 * would change something the user did not touch.
 */
function sandboxOptions(
  cwd: string | null,
  networkAccess: boolean | null,
  projectWorkspacePaths: readonly string[],
): Array<{ label: string; value: SandboxPatch; risky?: boolean }> {
  return [
    // Both of these must state a network flag, so neither can be offered until
    // the current one is known — sending a guess would change network access
    // as a side effect of changing the sandbox mode.
    ...(networkAccess !== null
      ? [
          {
            label: 'read-only',
            value: { type: 'readOnly' as const, networkAccess },
          },
          ...(cwd
            ? [
                {
                  label: 'workspace-write',
                  value: {
                    type: 'workspaceWrite' as const,
                    writableRoots: projectWorkspacePaths.filter(
                      (workspacePath) => workspacePath !== cwd,
                    ),
                    networkAccess,
                    excludeTmpdirEnvVar: false,
                    excludeSlashTmp: false,
                  },
                },
              ]
            : []),
        ]
      : []),
    // Full access has no network field of its own to preserve, so it stays
    // available even before anything has been observed.
    {
      label: 'danger-full-access',
      value: { type: 'dangerFullAccess' as const },
      risky: true,
    },
  ];
}

/**
 * Reads the network flag from whichever sandbox variant is currently in force.
 *
 * Returns null when nothing is known. That distinction matters: defaulting to
 * `false` contradicted the carry-over rule above by silently revoking network
 * access the conversation may well have had, which is a change the user never
 * asked for and could not see. The picker offers no network-bearing option
 * while this is null.
 */
function observedNetworkAccess(
  policy: ThreadSecurityPolicyDto['sandboxPolicy'] | undefined,
): boolean | null {
  if (!policy) return null;
  if (policy.type === 'dangerFullAccess') return true;
  if (policy.type === 'externalSandbox')
    return policy.networkAccess === 'enabled';
  return policy.networkAccess;
}

/** Maps a protocol sandbox tag to the label used by the picker and i18n. */
const SANDBOX_LABELS: Record<string, string> = {
  readOnly: 'read-only',
  workspaceWrite: 'workspace-write',
  dangerFullAccess: 'danger-full-access',
  externalSandbox: 'external-sandbox',
};

interface Props {
  threadId: string | null;
  /** Disables mutation for conversations this client cannot write to. */
  readOnly?: boolean;
}

export function SecurityPolicyBadge({ threadId, readOnly = false }: Props) {
  const { t } = useTranslation();
  const policy = useThreadSecurityPolicy(threadId);
  const threadCwd = useTimelineStore((s) => s.threadCwd);
  const projectsQuery = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => projectsApi<{ projects: ProjectSummary[] }>(),
  });
  const testProfile = useQuery({
    queryKey: ['agent-test-profile', threadId],
    queryFn: async () => {
      const authorization = getAuthorizationHeader();
      const response = await fetch(
        withBasePath(
          `/api/threads/${encodeURIComponent(threadId!)}/test-profile`,
        ),
        {
          headers: authorization ? { Authorization: authorization } : {},
        },
      );
      if (!response.ok) throw new Error('Test profile unavailable');
      return (await response.json()) as { available: boolean };
    },
    enabled: Boolean(threadId) && !readOnly,
    staleTime: 30_000,
  });
  const project = projectForWorkspace(projectsQuery.data?.projects, threadCwd);
  const currentWorkspace = project?.workspaces
    .filter(
      (workspace) =>
        workspace.path === threadCwd ||
        Boolean(threadCwd?.startsWith(`${workspace.path}/`)),
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
  const policyReadOnly = readOnly || currentWorkspace?.readOnly === true;
  const projectWorkspacePaths =
    project?.workspaces
      .filter((workspace) => !workspace.readOnly)
      .map((workspace) => workspace.path) ?? (threadCwd ? [threadCwd] : []);
  const desiredAdditionalRoots = projectWorkspacePaths.filter(
    (workspacePath) => workspacePath !== threadCwd,
  );
  const reconciliationKey = `${threadId ?? ''}:${desiredAdditionalRoots
    .slice()
    .sort()
    .join('|')}`;
  const attemptedReconciliation = useRef<string | null>(null);
  useEffect(() => {
    const sandbox = policy.observed?.sandboxPolicy;
    if (
      !threadId ||
      policyReadOnly ||
      !project ||
      sandbox?.type !== 'workspaceWrite' ||
      policy.pending ||
      sandboxOptionIsActive(sandbox, {
        ...sandbox,
        writableRoots: desiredAdditionalRoots,
      })
    ) {
      return;
    }
    if (attemptedReconciliation.current === reconciliationKey) return;
    attemptedReconciliation.current = reconciliationKey;
    policy.apply({
      sandboxPolicy: {
        ...sandbox,
        writableRoots: desiredAdditionalRoots,
      },
    });
  }, [
    desiredAdditionalRoots,
    policy,
    project,
    policyReadOnly,
    reconciliationKey,
    threadId,
  ]);
  if (!threadId) return null;

  const observedApproval = describeApproval(policy.observed?.approvalPolicy);
  const observedSandbox = sandboxMode(policy.observed?.sandboxPolicy);
  const sandboxLabel = observedSandbox
    ? (SANDBOX_LABELS[observedSandbox] ?? observedSandbox)
    : 'unknown';
  const risky =
    observedSandbox === 'dangerFullAccess' || observedApproval === 'never';
  const Icon = risky ? ShieldAlert : ShieldCheck;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-lg px-2 text-xs"
          title={`${t('securityPolicyForThisConversation')} : ${t(translationKey(sandboxLabel))} · ${t(translationKey(observedApproval))}`}
          aria-label={`${t('securityPolicyForThisConversation')} : ${t(translationKey(sandboxLabel))} · ${t(translationKey(observedApproval))}`}
        >
          {policy.isSettling ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Icon className="h-3.5 w-3.5" />
          )}
          <span className="hidden @min-[640px]/composer:inline">
            {t(translationKey(sandboxLabel))}
            <span className="mx-1 text-muted-foreground">·</span>
            {t(translationKey(observedApproval))}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-64 space-y-3 p-3 text-sm"
      >
        {/* An in-flight turn keeps the policy it captured at start, and running
            processes keep the authority they were launched with. Saying so is
            the difference between an honest control and the previous one. */}
        <p className="text-xs text-muted-foreground">
          {t('appliesToThisConversationFromTheNextMessage')}
        </p>

        {policy.unknown && (
          <p className="rounded bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
            {t('currentPolicyUnavailableUntilTheServerReportsIt')}
          </p>
        )}

        {/* A failed read leaves the last observation in place, because replacing
            a known policy with a guess is worse. It must not keep being
            presented as current, though: the conversation may have been changed
            from the CLI or another client in exactly the window that could not
            be read. */}
        {policy.stale && (
          <p className="rounded bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
            {t('showingTheLastKnownPolicyItCouldNotBeReReadJustNow')}
          </p>
        )}

        {/* Three distinct endings, because they are not the same fact. A refused
            patch and a patch that measurably failed to take effect both mean
            the conversation kept its old policy, which the badge above is now
            showing again. An unreadable policy means nobody knows, and saying
            "unchanged" there would be a guess dressed as a result. */}
        {policy.outcome && policy.outcome !== 'pending' && (
          <div className="space-y-1.5 rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            <p>
              {policy.outcome === 'unknown'
                ? t(
                    'couldNotConfirmThePolicyChangeCheckTheCurrentValueBeforeSending',
                  )
                : t(
                    'thePolicyChangeDidNotTakeEffectThisConversationIsStillOnTheSettingsShownAbove',
                  )}
            </p>
            <div className="flex gap-2">
              {policy.pending && (
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => policy.pending && policy.apply(policy.pending)}
                >
                  {t('tryAgain')}
                </button>
              )}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={policy.dismiss}
              >
                {t('dismiss')}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t('approval')}
          </div>
          {APPROVAL_OPTIONS.map((option) => (
            <OptionRow
              key={option}
              label={option}
              active={observedApproval === option}
              requested={policy.pending?.approvalPolicy === option}
              risky={option === 'never'}
              disabled={policyReadOnly || policy.isSettling}
              onClick={() => policy.apply({ approvalPolicy: option })}
            />
          ))}
        </div>

        <div className="space-y-1 border-t border-border pt-2">
          <div className="text-xs font-medium text-muted-foreground">
            {t('sandbox')}
          </div>
          {sandboxOptions(
            policyReadOnly ? null : threadCwd,
            observedNetworkAccess(policy.observed?.sandboxPolicy),
            projectWorkspacePaths,
          ).map((option) => (
            <OptionRow
              key={option.label}
              label={option.label}
              active={sandboxOptionIsActive(
                policy.observed?.sandboxPolicy,
                option.value,
              )}
              requested={
                policy.pending?.sandboxPolicy?.type === option.value.type
              }
              risky={option.risky}
              disabled={policyReadOnly || policy.isSettling}
              onClick={() => policy.apply({ sandboxPolicy: option.value })}
            />
          ))}
        </div>

        <div className="space-y-1 border-t border-border pt-2">
          <div className="text-xs font-medium text-muted-foreground">
            {t('agentTestProfile')}
          </div>
          <OptionRow
            label="agentTestProfileEnable"
            active={false}
            disabled={
              policyReadOnly ||
              policy.isSettling ||
              policy.stale ||
              policy.unknown ||
              !threadCwd ||
              !testProfile.data?.available ||
              policy.observed?.sandboxPolicy?.type !== 'workspaceWrite' ||
              policy.observed.sandboxPolicy.networkAccess
            }
            onClick={() => {
              const sandbox = policy.observed?.sandboxPolicy;
              if (
                sandbox?.type !== 'workspaceWrite' ||
                policy.stale ||
                policy.unknown ||
                !testProfile.data?.available
              )
                return;
              policy.apply({
                sandboxPolicy: { ...sandbox, networkAccess: true },
              });
            }}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              testProfile.data?.available
                ? 'agentTestProfileHint'
                : 'agentTestProfileUnavailable',
            )}
          </p>
          {policy.observed?.sandboxPolicy?.type === 'workspaceWrite' &&
            policy.observed.sandboxPolicy.networkAccess && (
              <OptionRow
                label="agentTestProfileDisable"
                active={false}
                disabled={
                  policyReadOnly ||
                  policy.isSettling ||
                  policy.stale ||
                  policy.unknown
                }
                onClick={() => {
                  const sandbox = policy.observed?.sandboxPolicy;
                  if (sandbox?.type === 'workspaceWrite')
                    policy.apply({
                      sandboxPolicy: { ...sandbox, networkAccess: false },
                    });
                }}
              />
            )}
        </div>

        <p className="border-t border-border pt-2 text-xs text-muted-foreground">
          {t('theDefaultForNewConversationsLivesInSettings')}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function sandboxOptionIsActive(
  observed: ThreadSecurityPolicyDto['sandboxPolicy'] | undefined,
  option: SandboxPatch,
): boolean {
  if (!observed || observed.type !== option.type) return false;
  if (observed.type !== 'workspaceWrite' || option.type !== 'workspaceWrite')
    return true;
  return (
    observed.writableRoots.length === option.writableRoots.length &&
    option.writableRoots.every((root) => observed.writableRoots.includes(root))
  );
}

function OptionRow({
  label,
  active,
  requested,
  risky,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  /** Chosen by the user but not yet observed as effective. */
  requested?: boolean;
  risky?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      disabled={disabled || active}
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        active
          ? risky
            ? 'bg-destructive/10 text-destructive'
            : 'bg-accent text-accent-foreground'
          : 'hover:bg-accent/50',
        risky && !active && 'text-destructive',
        disabled && !active && 'opacity-50',
      )}
    >
      {t(translationKey(label))}
      {active && (
        <Badge
          variant={risky ? 'destructive' : 'secondary'}
          className="text-[10px]"
        >
          {t('current')}
        </Badge>
      )}
      {/* Requested-but-unconfirmed is its own state on purpose: presenting it
          as current is exactly how the old control managed to be wrong. */}
      {!active && requested && (
        <Badge variant="outline" className="text-[10px]">
          {t('applying')}
        </Badge>
      )}
    </button>
  );
}

function describeApproval(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return 'granular';
  return 'unknown';
}
