import { translationKey } from '@/locales/translation-key';
/**
 * Codex app-server config management tab.
 *
 * Two modes:
 * 1. Structured editor — curated fields with per-field controls
 * 2. Raw editor — Monaco-based config.toml editing for power users
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Brain,
  FileCode2,
  FileText,
  ShieldCheck,
  UserCog,
  UserCircle,
  PackageOpen,
} from 'lucide-react';
import {
  ApprovalReviewerControl,
  ConfigSelectOverrideControl,
  ConfigSourceBadge,
  type OverrideSelectOption,
} from '@/components/codex-config/config-override-controls';
import { RawConfigEditor } from './raw-config-editor';
import { SettingsSaveBar } from './settings-save-bar';
import { loadAdminModels } from './admin-model-options';
import { CatalogSettings } from './catalog/catalog-settings';
import { AccountSettings } from './account/account-settings';
import { CodexCliSettings } from './codex-cli-settings';
import { useAccountStore } from '@/stores/account-store';
import {
  catalogStateQueryKey,
  accountReadAccountQueryKey,
  codexConfigReadConfigOptions,
  codexConfigUpdateConfigMutation,
  codexStatusGetStatusOptions,
  modelsListModelsOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import type {
  CatalogWarningDto,
  ConfigEditDto,
} from '@/generated/api/types.gen';
import { accountReadAccount } from '@/generated/api/sdk.gen';
import { showSnackbar } from '@/stores/snackbar-store';
import {
  APPROVAL_REVIEWER_VALUES,
  type ApprovalReviewerValue,
  type ConfigRecord,
  configValueToString,
  formatConfigValue,
  isApprovalReviewerValue,
  isUserConfigOrigin,
  originLabel,
  resolveConfigValue,
} from '@/lib/codex-config';
import { ConfigFieldEditor } from './codex-settings-fields';
import { cn } from '@/lib/utils';
import {
  FIELD_DEFS,
  type FieldDef,
  GROUP_ORDER,
  stringToConfigValue,
} from './codex-settings-defs';

// ---------------------------------------------------------------------------
// Security read-only fields
// ---------------------------------------------------------------------------

const SECURITY_READONLY_KEYS = ['sandbox_workspace_write'] as const;

type CodexSettingsTab =
  | 'account'
  | 'cli'
  | 'profile'
  | 'model'
  | 'instructions'
  | 'reasoning'
  | 'security'
  | 'raw';

const CODEX_SETTINGS_TABS = [
  { id: 'account', label: 'Account', icon: UserCircle },
  { id: 'cli', label: 'Codex CLI', icon: PackageOpen },
  { id: 'profile', label: 'Profile', icon: UserCog },
  { id: 'model', label: 'Model', icon: Bot },
  { id: 'instructions', label: 'Instructions', icon: FileText },
  { id: 'reasoning', label: 'Reasoning', icon: Brain },
  { id: 'security', label: 'Security', icon: ShieldCheck },
  { id: 'raw', label: 'Raw configuration', icon: FileCode2 },
] as const;

const TAB_GROUPS: Partial<Record<CodexSettingsTab, string>> = {
  profile: 'Profile',
  model: 'Model',
  instructions: 'Instructions',
  reasoning: 'Reasoning',
};

const SECURITY_FIELD_LABELS: Record<
  (typeof SECURITY_READONLY_KEYS)[number],
  string
> = {
  sandbox_workspace_write: 'Sandbox Workspace Write',
};

/**
 * Global defaults for conversations started from now on.
 *
 * These are editable here and nowhere else. The chat badge changes ONE
 * conversation, which is a different thing — writing the global keys was
 * measured not to reach a thread that is already loaded. Both controls existing
 * is the point; for a while the badge pointed here for the default while this
 * page pointed back at the badge, leaving no way to change it outside the raw
 * TOML editor.
 *
 * The approval list is exactly the pinned config schema's: `untrusted` was
 * retired from it and makes the app-server refuse to start, `on-failure` no
 * longer exists, and the granular object form has no place in a two-choice
 * picker. Offering a value the server rejects would break every future
 * conversation from a settings page.
 */
const APPROVAL_POLICY_VALUES = ['on-request', 'never'] as const;
type ApprovalPolicyValue = (typeof APPROVAL_POLICY_VALUES)[number];
const isApprovalPolicyValue = (value: unknown): value is ApprovalPolicyValue =>
  typeof value === 'string' &&
  (APPROVAL_POLICY_VALUES as readonly string[]).includes(value);

const SANDBOX_MODE_VALUES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;
type SandboxModeValue = (typeof SANDBOX_MODE_VALUES)[number];
const isSandboxModeValue = (value: unknown): value is SandboxModeValue =>
  typeof value === 'string' &&
  (SANDBOX_MODE_VALUES as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CodexSettings({
  initialTab = 'account',
}: { initialTab?: 'account' | 'cli' } = {}) {
  const { t, i18n } = useTranslation();
  const isNonEnglish = !i18n.language.startsWith('en');
  const queryClient = useQueryClient();
  const [requestedTab, setActiveTab] = useState<CodexSettingsTab>(initialTab);
  const accountQuery = useQuery({
    queryKey: accountReadAccountQueryKey(),
    queryFn: async () => {
      const { data } = await accountReadAccount({ throwOnError: true });
      useAccountStore.getState().setAccount(data);
      return data;
    },
    retry: false,
    refetchOnWindowFocus: true,
  });
  const authMode = useAccountStore((state) => state.authMode);
  const connected =
    Boolean(accountQuery.data?.account) &&
    !accountQuery.isError &&
    Boolean(authMode);
  const activeTab =
    connected || requestedTab === 'cli' ? requestedTab : 'account';

  // ---- Queries ----
  const configQuery = useQuery({
    ...codexConfigReadConfigOptions(),
    enabled: connected,
  });

  const config = configQuery.data?.config as ConfigRecord | undefined;
  const origins = configQuery.data?.origins as ConfigRecord | undefined;

  // ---- Drafts: same pattern as useCategorySettings ----
  // draftOverrides stores user edits; base values come from config via useMemo.
  const [draftOverrides, setDraftOverrides] = useState<Record<string, string>>(
    {},
  );
  const [clearedKeys, setClearedKeys] = useState<Set<string>>(new Set());

  const baseDrafts = useMemo(() => {
    if (!config) return {};
    const base: Record<string, string> = {};
    for (const def of FIELD_DEFS) {
      base[def.key] = configValueToString(config[def.key]);
    }
    base.approval_policy = isApprovalPolicyValue(config.approval_policy)
      ? config.approval_policy
      : 'on-request';
    base.sandbox_mode = isSandboxModeValue(config.sandbox_mode)
      ? config.sandbox_mode
      : 'read-only';
    base.approvals_reviewer = isApprovalReviewerValue(config.approvals_reviewer)
      ? config.approvals_reviewer
      : 'user';
    return base;
  }, [config]);

  const drafts = useMemo(
    () => ({ ...baseDrafts, ...draftOverrides }),
    [baseDrafts, draftOverrides],
  );

  const dirtyKeys = useMemo(() => {
    const keys = new Set<string>(clearedKeys);
    for (const [key, value] of Object.entries(draftOverrides)) {
      if (value !== baseDrafts[key]) keys.add(key);
    }
    return keys;
  }, [draftOverrides, baseDrafts, clearedKeys]);

  const handleDraftChange = useCallback((key: string, value: string) => {
    setClearedKeys((previous) => {
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
    setDraftOverrides((prev) => ({ ...prev, [key]: value }));
  }, []);

  // ---- Mutations ----
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: codexConfigReadConfigOptions().queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: codexStatusGetStatusOptions().queryKey,
    });
    // A raw edit can move model_catalog_json, so the catalog panel's notion of
    // configured vs running is stale the moment config.toml is written.
    void queryClient.invalidateQueries({ queryKey: catalogStateQueryKey() });
    void queryClient.invalidateQueries({
      queryKey: modelsListModelsOptions().queryKey,
    });
  }, [queryClient]);

  const [saveWarnings, setSaveWarnings] = useState<CatalogWarningDto[]>([]);

  const updateMutation = useMutation({
    ...codexConfigUpdateConfigMutation(),
    onSuccess: (data, variables) => {
      // Optimistically update the query cache with the returned config
      queryClient.setQueryData(codexConfigReadConfigOptions().queryKey, data);
      // Held separately from the query: warnings are produced by the write, and
      // the invalidation below refetches a read that does not carry them. This
      // is where "the configured model is not in the catalog" surfaces at all.
      setSaveWarnings(data.warnings ?? []);
      invalidate();
      showSnackbar(t('configSaved'), 'success');
      // Only clear drafts for saved keys, preserve other pending edits
      const savedKeys = new Set(variables.body.edits.map((e) => e.keyPath));
      setClearedKeys(
        (previous) =>
          new Set([...previous].filter((key) => !savedKeys.has(key))),
      );
      setDraftOverrides((prev) => {
        const next = { ...prev };
        for (const key of savedKeys) delete next[key];
        return next;
      });
    },
    onError: (err) => {
      showSnackbar(t('failedToSaveConfigMsg', { msg: String(err) }), 'error');
    },
  });

  const handleClearField = useCallback((key: ConfigEditDto['keyPath']) => {
    setClearedKeys((previous) => new Set([...previous, key]));
    setDraftOverrides((previous) => ({ ...previous, [key]: '' }));
  }, []);

  // ---- Profile options (dynamic from config.profiles) ----
  const profileOptions = useMemo(() => {
    const activeProfile = configValueToString(config?.profile);
    const profiles = config?.profiles;
    const options: string[] = [];
    if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
      options.push(...Object.keys(profiles));
    }
    // Ensure the current active profile appears even if not in profiles map
    if (activeProfile && !options.includes(activeProfile)) {
      options.push(activeProfile);
    }
    return options;
  }, [config]);

  // ---- Service tier options (dynamic from the model catalog) ----
  // Tier ids are advertised per model and opaque to the app-server, so this
  // cannot be a static list. It previously hardcoded `fast` / `flex`, which the
  // real catalog does not use — the gpt-5.6 family returns `priority` and
  // `ultrafast` — so the control could only ever write invalid values. The
  // config key is global, hence the union across models rather than one model's
  // set. Any tier already written to config is kept so an existing value is
  // never silently dropped from the list.
  const modelsQuery = useQuery({
    enabled: connected,
    ...modelsListModelsOptions(),
    queryFn: ({ signal }) => loadAdminModels(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const modelsData = modelsQuery.data;
  const serviceTierOptions = useMemo(() => {
    const options: string[] = [];
    for (const model of modelsData?.data ?? []) {
      for (const tier of model.serviceTiers) {
        if (!options.includes(tier.id)) options.push(tier.id);
      }
    }
    const current = configValueToString(config?.['service_tier']);
    if (current && !options.includes(current)) options.push(current);
    return options;
  }, [modelsData, config]);

  const reviewerOptions = useMemo<
    readonly OverrideSelectOption<ApprovalReviewerValue>[]
  >(
    () =>
      APPROVAL_REVIEWER_VALUES.map((value) => ({
        value,
        label:
          value === 'user'
            ? t('user')
            : value === 'auto_review'
              ? t('automaticReview')
              : t('guardianSubagent'),
      })),
    [t],
  );

  const topLevelReviewer = useMemo(
    () =>
      resolveConfigValue(
        config,
        origins,
        ['approvals_reviewer'],
        'user',
        isApprovalReviewerValue,
      ),
    [config, origins],
  );

  // Read from the same curated config the rest of this page uses, so the
  // control shows what the server actually resolved rather than what this tab
  // last wrote.
  const globalApprovalPolicy = useMemo(
    () =>
      resolveConfigValue(
        config,
        origins,
        ['approval_policy'],
        'on-request' as ApprovalPolicyValue,
        isApprovalPolicyValue,
      ),
    [config, origins],
  );

  const globalSandboxMode = useMemo(
    () =>
      resolveConfigValue(
        config,
        origins,
        ['sandbox_mode'],
        'read-only' as SandboxModeValue,
        isSandboxModeValue,
      ),
    [config, origins],
  );

  // ---- Group fields ----
  const groupedFields = useMemo(() => {
    const map = new Map<string, FieldDef[]>();
    for (const group of GROUP_ORDER) {
      map.set(group, []);
    }
    for (const def of FIELD_DEFS) {
      const list = map.get(def.group) ?? [];
      list.push(def);
      map.set(def.group, list);
    }
    return map;
  }, []);

  // The structured editor is what withdraws on a failed or pending read; the raw
  // editor keeps ONE position in the tree across every state. Returning early
  // per state would remount it, and a remount discards the unsaved TOML the user
  // came here to write — which is most likely exactly when the read is failing.
  const unavailable = configQuery.isLoading ? (
    <div className="rounded-lg border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
      {t('loadingb04ba49f')}
    </div>
  ) : (
    <div className="rounded-lg border border-destructive/30 bg-card/50 px-4 py-3 text-sm text-destructive">
      {t('failedToLoadCodexConfig')}
    </div>
  );

  const visibleTabs = CODEX_SETTINGS_TABS.filter(
    (tab) => tab.id !== 'profile' || profileOptions.length > 0,
  );
  const activeGroup = TAB_GROUPS[activeTab];
  const activeFields = activeGroup
    ? (groupedFields.get(activeGroup) ?? [])
    : [];
  const needsStructuredConfig = !['raw', 'account', 'cli'].includes(activeTab);
  const activeKeys =
    activeTab === 'security'
      ? ['approval_policy', 'sandbox_mode', 'approvals_reviewer']
      : activeFields.map((field) => field.key);
  const activeDirtyKeys = activeKeys.filter((key) => dirtyKeys.has(key));
  const saveActiveTab = () => {
    const edits: ConfigEditDto[] = [];
    for (const key of activeDirtyKeys) {
      if (clearedKeys.has(key)) {
        edits.push({ keyPath: key, value: null });
        continue;
      }
      const result = stringToConfigValue(key, drafts[key] ?? '');
      if (!result.ok) {
        showSnackbar(t(translationKey(result.error)), 'error');
        return;
      }
      edits.push({ keyPath: key, value: result.value });
    }
    if (edits.length) updateMutation.mutate({ body: { edits } });
  };
  const modelOptions = [
    ...new Set(
      (modelsData?.data ?? [])
        .filter((model) => !model.hidden)
        .map((model) => model.model),
    ),
  ];
  const activeModel = modelsData?.data.find((model) =>
    drafts.model ? model.model === drafts.model : model.isDefault,
  );
  const reasoningOptions = [
    ...new Set(
      (activeModel ? [activeModel] : (modelsData?.data ?? [])).flatMap(
        (model) =>
          model.supportedReasoningEfforts.map(
            (option) => option.reasoningEffort,
          ),
      ),
    ),
  ];
  const configuredProviders = config?.model_providers;
  const providerOptions =
    configuredProviders &&
    typeof configuredProviders === 'object' &&
    !Array.isArray(configuredProviders)
      ? Object.keys(configuredProviders)
      : [];

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 min-w-0 shrink-0 items-center border-b bg-background">
        <div
          role="tablist"
          aria-label={t('codexConfigurationSections')}
          className="flex min-w-0 flex-1 items-center overflow-x-auto"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
              return;
            const tabs = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]:not(:disabled)',
              ),
            ];
            const current = tabs.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const index =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (current +
                      (event.key === 'ArrowRight' ? 1 : -1) +
                      tabs.length) %
                    tabs.length;
            event.preventDefault();
            tabs[index]?.focus();
            tabs[index]?.click();
          }}
        >
          {visibleTabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              disabled={id !== 'account' && id !== 'cli' && !connected}
              aria-selected={activeTab === id}
              aria-controls="codex-settings-panel"
              tabIndex={activeTab === id ? 0 : -1}
              title={t(translationKey(label))}
              onClick={() => setActiveTab(id)}
              className={cn(
                'flex h-10 shrink-0 cursor-pointer items-center gap-2 border-b-2 px-3 text-xs transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px] disabled:cursor-not-allowed disabled:opacity-50',
                activeTab === id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              <span>{t(translationKey(label))}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 sm:px-6">
        {activeTab === 'cli' && (
          <div id="codex-settings-panel" role="tabpanel">
            <CodexCliSettings />
          </div>
        )}
        {activeTab === 'account' && (
          <div id="codex-settings-panel" role="tabpanel">
            <AccountSettings />
          </div>
        )}
        {/* Keep catalog repair available even when structured config cannot load. */}
        {activeTab === 'model' && <CatalogSettings />}
        {needsStructuredConfig &&
        (!config || configQuery.isError || configQuery.isLoading) ? (
          unavailable
        ) : (
          <>
            {saveWarnings.length > 0 && (
              <ul className="space-y-1 text-xs text-amber-500">
                {saveWarnings.map((warning, index) => (
                  <li key={index}>
                    {warning.model ? `${warning.model}: ` : ''}
                    {warning.message}
                  </li>
                ))}
              </ul>
            )}

            {activeGroup && (
              <div
                id="codex-settings-panel"
                role="tabpanel"
                className="space-y-3"
              >
                {modelsQuery.isError &&
                  ['model', 'reasoning'].includes(activeTab) && (
                    <p role="alert" className="text-xs text-amber-500">
                      {t(
                        'liveModelChoicesAreUnavailableExistingValuesArePreservedCustomModelIdentifiersCb466fb89',
                      )}
                    </p>
                  )}
                {activeFields.map((def) => (
                  <ConfigFieldEditor
                    key={def.key}
                    def={def}
                    draft={drafts[def.key] ?? ''}
                    dirty={dirtyKeys.has(def.key)}
                    origin={originLabel(origins, def.key)}
                    overridden={isUserConfigOrigin(origins, def.key)}
                    saving={updateMutation.isPending}
                    batch
                    modelOptions={
                      def.key === 'model' || def.key === 'review_model'
                        ? modelOptions
                        : def.key === 'model_provider'
                          ? providerOptions
                          : undefined
                    }
                    dynamicOptions={
                      def.key === 'model_reasoning_effort'
                        ? reasoningOptions
                        : undefined
                    }
                    profileOptions={
                      def.key === 'profile' ? profileOptions : undefined
                    }
                    serviceTierOptions={
                      def.key === 'service_tier'
                        ? serviceTierOptions
                        : undefined
                    }
                    onDraftChange={handleDraftChange}
                    onSave={saveActiveTab}
                    onClear={handleClearField}
                  />
                ))}
              </div>
            )}

            {activeTab === 'security' && (
              <div
                id="codex-settings-panel"
                role="tabpanel"
                className="space-y-3"
              >
                <p className="text-xs text-muted-foreground">
                  {t(
                    'defaultsForNewConversationsChangingThemDoesNotAffectAConversationAlreadyOpenUse71a22217',
                  )}
                </p>
                <ConfigSelectOverrideControl
                  deferred
                  label={t('approvalPolicy')}
                  description={t('whenCodexAsksBeforeRunningACommand')}
                  effectiveValue={
                    (drafts.approval_policy ||
                      globalApprovalPolicy.value) as ApprovalPolicyValue
                  }
                  source={globalApprovalPolicy.source}
                  overridden={isUserConfigOrigin(origins, 'approval_policy')}
                  saving={updateMutation.isPending}
                  options={APPROVAL_POLICY_VALUES.map((value) => ({
                    value,
                    label: t(translationKey(value)),
                  }))}
                  onCommit={(value) =>
                    value === null
                      ? handleClearField('approval_policy')
                      : handleDraftChange('approval_policy', value)
                  }
                />
                <ConfigSelectOverrideControl
                  deferred
                  label={t('sandboxMode')}
                  description={t('whatACommandMayReachByDefault')}
                  effectiveValue={
                    (drafts.sandbox_mode ||
                      globalSandboxMode.value) as SandboxModeValue
                  }
                  source={globalSandboxMode.source}
                  overridden={isUserConfigOrigin(origins, 'sandbox_mode')}
                  saving={updateMutation.isPending}
                  options={SANDBOX_MODE_VALUES.map((value) => ({
                    value,
                    label: t(translationKey(value)),
                  }))}
                  onCommit={(value) =>
                    value === null
                      ? handleClearField('sandbox_mode')
                      : handleDraftChange('sandbox_mode', value)
                  }
                />
                <ApprovalReviewerControl
                  deferred
                  label={t('approvalsReviewer')}
                  description={t('defaultReviewerForApprovalRequests')}
                  effectiveValue={
                    (drafts.approvals_reviewer ||
                      topLevelReviewer.value) as ApprovalReviewerValue
                  }
                  source={topLevelReviewer.source}
                  overridden={isUserConfigOrigin(origins, 'approvals_reviewer')}
                  saving={updateMutation.isPending}
                  options={reviewerOptions}
                  onCommit={(value) =>
                    value === null
                      ? handleClearField('approvals_reviewer')
                      : handleDraftChange('approvals_reviewer', value)
                  }
                />
                {SECURITY_READONLY_KEYS.map((key) => (
                  <div
                    key={key}
                    className="space-y-1 overflow-hidden rounded-lg border border-border bg-card/50 px-4 py-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {t(translationKey(SECURITY_FIELD_LABELS[key]))}
                      </span>
                      {isNonEnglish && (
                        <code className="text-xs text-muted-foreground">
                          {key}
                        </code>
                      )}
                      <ConfigSourceBadge source={originLabel(origins, key)} />
                    </div>
                    <p className="break-all text-xs text-muted-foreground">
                      {formatConfigValue(config?.[key])}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div
          id={activeTab === 'raw' ? 'codex-settings-panel' : undefined}
          role={activeTab === 'raw' ? 'tabpanel' : undefined}
          className={activeTab === 'raw' ? undefined : 'hidden'}
        >
          {connected && <RawConfigEditor onSaved={invalidate} />}
        </div>
        {needsStructuredConfig && config && !configQuery.isError && (
          <>
            {activeKeys.some((key) => clearedKeys.has(key)) && (
              <p role="status" className="text-xs text-amber-500">
                {t('returnToInheritancePendingSaveThisTabToApply')}
              </p>
            )}
            <SettingsSaveBar
              dirty={activeDirtyKeys.length > 0}
              saving={updateMutation.isPending}
              onSave={saveActiveTab}
              onDiscard={() => {
                setClearedKeys(
                  (previous) =>
                    new Set(
                      [...previous].filter((key) => !activeKeys.includes(key)),
                    ),
                );
                setDraftOverrides((previous) => {
                  const next = { ...previous };
                  for (const key of activeKeys) delete next[key];
                  return next;
                });
              }}
            />
          </>
        )}
      </div>
    </section>
  );
}
