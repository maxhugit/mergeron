import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  localAgentsApi,
  localAgentModelsKey,
  type LocalAgentCatalog,
} from '@/lib/local-agents';
import type { WorkspaceGroup } from './sidebar/sidebar-types';
export function LocalAgentDialog({
  group,
  pending,
  onClose,
  onCreate,
}: {
  group: WorkspaceGroup;
  pending: boolean;
  onClose: () => void;
  onCreate: (input: { workspacePath: string; model: string }) => void;
}) {
  const { t } = useTranslation(['common', 'localAgents'], {
    nsMode: 'fallback',
  });
  const [model, setModel] = useState('');
  const [workspace, setWorkspace] = useState(
    group.workspaces?.[0]?.path ?? group.cwd,
  );
  const query = useQuery({
    queryKey: localAgentModelsKey,
    queryFn: ({ signal }) =>
      localAgentsApi<LocalAgentCatalog>('models', undefined, signal),
    retry: false,
    staleTime: 30000,
  });
  const models = query.data?.data ?? [];
  const selected = model || models[0]?.model || '';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('localAgentCreate')}</DialogTitle>
          <DialogDescription>{t('localAgentsScope')}</DialogDescription>
        </DialogHeader>
        <label className="grid gap-1 text-sm">
          {t('localAgentsWorkspace')}
          <select
            className="h-10 rounded-md border border-input bg-background px-3"
            value={workspace}
            disabled={pending}
            onChange={(e) => setWorkspace(e.target.value)}
          >
            {(group.workspaces?.length
              ? group.workspaces
              : [{ path: group.cwd, name: group.cwd }]
            ).map((w) => (
              <option key={w.path} value={w.path}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t('model')}
          <select
            className="h-10 rounded-md border border-input bg-background px-3"
            value={selected}
            disabled={pending || !models.length}
            onChange={(e) => setModel(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
        {query.isPending && <p role="status">{t('loading')}</p>}
        {(query.isError || (!query.isPending && !query.data?.available)) && (
          <p role="alert" className="text-sm text-destructive">
            {t('localAgentsUnavailable')}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {t('localAgentsCreationHelp')}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void query.refetch()}
            disabled={pending || query.isFetching}
          >
            {t('tryAgain')}
          </Button>
          <Button
            disabled={
              pending ||
              !query.data?.available ||
              !models.some((m) => m.model === selected) ||
              !workspace
            }
            onClick={() =>
              onCreate({ model: selected, workspacePath: workspace })
            }
          >
            {t('localAgentCreate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
