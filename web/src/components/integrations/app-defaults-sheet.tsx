/** App-default policy drawer for Codex connected apps. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  appsListAppsQueryKey,
  codexConfigReadConfigOptions,
  codexConfigUpdateConfigMutation,
  codexStatusGetStatusOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import type { ConfigEditDto } from '@/generated/api/types.gen';
import {
  ApprovalReviewerControl,
  ConfigBooleanOverrideControl,
  ConfigSelectOverrideControl,
} from '@/components/codex-config/config-override-controls';
import type { ConfigRecord } from '@/lib/codex-config';
import { isUserConfigOrigin } from '@/lib/codex-config';
import { getApiErrorMessage } from '@/lib/api-error';
import { showSnackbar } from '@/stores/snackbar-store';
import { PolicySection, WarningBanner } from './app-detail-layout';
import {
  queryHasId,
  resolveApprovalMode,
  resolveBoolean,
  resolveReviewer,
  useApprovalModeOptions,
  useReviewerOptions,
} from './app-config-helpers';

type ConfigKeyPath = ConfigEditDto['keyPath'];
type ConfigValue = ConfigEditDto['value'];

interface AppDefaultsSheetProps {
  /** Whether the drawer is open. */
  open: boolean;
  /** Closes the drawer. */
  onClose: () => void;
}

/** Detail surface for app-default policy values inherited by individual apps. */
export function AppDefaultsSheet({ open, onClose }: AppDefaultsSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    ...codexConfigReadConfigOptions(),
    enabled: open,
  });
  const updateMutation = useMutation({
    ...codexConfigUpdateConfigMutation(),
    onSuccess: (data) => {
      queryClient.setQueryData(codexConfigReadConfigOptions().queryKey, data);
      void queryClient.invalidateQueries({
        queryKey: codexConfigReadConfigOptions().queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: codexStatusGetStatusOptions().queryKey,
      });
      void queryClient.invalidateQueries({ queryKey: appsListAppsQueryKey() });
      void queryClient.invalidateQueries({
        predicate: (query) => queryHasId(query, 'appsReadApps'),
      });
      showSnackbar(t('configSaved'), 'success');
    },
    onError: (error) => showSnackbar(getApiErrorMessage(error), 'error'),
  });

  const config = configQuery.data?.config as ConfigRecord | undefined;
  const origins = configQuery.data?.origins as ConfigRecord | undefined;
  const reviewerOptions = useReviewerOptions();
  const approvalModeOptions = useApprovalModeOptions();
  const defaultBase = 'apps._default';

  // Fallbacks mirror what the app-server fills in when `[apps._default]` exists
  // but leaves a field unset. All three default to enabled; showing `false` here
  // would tell the user destructive and open-world tools are blocked while the
  // server actually permits them.
  const enabled = resolveBoolean(
    config,
    origins,
    [`${defaultBase}.enabled`],
    true,
  );
  const destructive = resolveBoolean(
    config,
    origins,
    [`${defaultBase}.destructive_enabled`],
    true,
  );
  const openWorld = resolveBoolean(
    config,
    origins,
    [`${defaultBase}.open_world_enabled`],
    true,
  );
  const defaultToolApproval = resolveApprovalMode(config, origins, [
    `${defaultBase}.default_tools_approval_mode`,
  ]);
  const reviewer = resolveReviewer(config, origins, [
    `${defaultBase}.approvals_reviewer`,
    'approvals_reviewer',
  ]);

  const writeConfig = (keyPath: ConfigKeyPath, value: ConfigValue) => {
    updateMutation.mutate({
      body: { edits: [{ keyPath, value }] },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="bg-popover! max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('appDefaults')}</DialogTitle>
          <DialogDescription>
            {t('defaultsInheritedByConnectedAppsWithoutLocalOverrides')}
          </DialogDescription>
        </DialogHeader>

        {configQuery.isLoading ? (
          <div className="space-y-3 px-4 pt-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : configQuery.isError || !config ? (
          <div className="px-4 pt-2">
            <WarningBanner message={t('failedToLoadCodexConfigb48ffe49')} />
          </div>
        ) : (
          <ScrollArea className="h-[55dvh] px-4 pr-2">
            <PolicySection title={t('defaultAppSettings')}>
              <ConfigBooleanOverrideControl
                label={t('appsEnabled')}
                effectiveValue={enabled.value}
                source={enabled.source}
                overridden={isUserConfigOrigin(
                  origins,
                  `${defaultBase}.enabled`,
                )}
                saving={updateMutation.isPending}
                onCommit={(value) =>
                  writeConfig(`${defaultBase}.enabled`, value)
                }
              />
              <ConfigBooleanOverrideControl
                label={t('destructiveTools')}
                effectiveValue={destructive.value}
                source={destructive.source}
                overridden={isUserConfigOrigin(
                  origins,
                  `${defaultBase}.destructive_enabled`,
                )}
                saving={updateMutation.isPending}
                onCommit={(value) =>
                  writeConfig(`${defaultBase}.destructive_enabled`, value)
                }
              />
              <ConfigBooleanOverrideControl
                label={t('openWorldTools')}
                effectiveValue={openWorld.value}
                source={openWorld.source}
                overridden={isUserConfigOrigin(
                  origins,
                  `${defaultBase}.open_world_enabled`,
                )}
                saving={updateMutation.isPending}
                onCommit={(value) =>
                  writeConfig(`${defaultBase}.open_world_enabled`, value)
                }
              />
              <ConfigSelectOverrideControl
                label={t('defaultToolApproval')}
                effectiveValue={defaultToolApproval.value}
                source={defaultToolApproval.source}
                overridden={isUserConfigOrigin(
                  origins,
                  `${defaultBase}.default_tools_approval_mode`,
                )}
                saving={updateMutation.isPending}
                options={approvalModeOptions}
                onCommit={(value) =>
                  writeConfig(
                    `${defaultBase}.default_tools_approval_mode`,
                    value,
                  )
                }
              />
              <ApprovalReviewerControl
                label={t('appApprovalReviewer')}
                description={t('defaultReviewerUsedByAppsWithoutAnAppOverride')}
                effectiveValue={reviewer.value}
                source={reviewer.source}
                overridden={isUserConfigOrigin(
                  origins,
                  `${defaultBase}.approvals_reviewer`,
                )}
                saving={updateMutation.isPending}
                options={reviewerOptions}
                onCommit={(value) =>
                  writeConfig(`${defaultBase}.approvals_reviewer`, value)
                }
              />
            </PolicySection>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
