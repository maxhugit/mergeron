import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitGraphTarget } from '@/stores/workspace-store';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GitBranchGraph } from './git-branch-graph';

/** Read-only workspace view. Selecting a graph never selects an agent folder. */
export function WorkspaceGitGraph({
  target,
  active,
}: {
  target: GitGraphTarget;
  active: boolean;
}) {
  const { t } = useTranslation('workspaces');
  const [scope, setScope] = useState(target.copyId ? 'local' : 'remote');
  const local = scope === 'local' && Boolean(target.copyId);
  return (
    <section
      className="min-h-0 flex-1 overflow-auto"
      aria-label={`${t('gitGraphTitle')} · ${target.name}`}
    >
      <header className="border-b p-3">
        <h2 className="font-medium">{target.name}</h2>
      </header>
      <Tabs value={local ? 'local' : 'remote'} onValueChange={setScope}>
        <TabsList className="flex flex-wrap gap-1 border-b p-2">
          {target.copyId && (
            <TabsTrigger value="local" className="px-3 py-2 text-xs">
              {t('gitScopeLocal')}
            </TabsTrigger>
          )}
          <TabsTrigger value="remote" className="px-3 py-2 text-xs">
            {t('gitScopeRemote')}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <GitBranchGraph
        key={local ? target.copyId : target.resourceId}
        projectId={target.projectId}
        copyId={local ? target.copyId! : undefined}
        resourceId={target.resourceId}
        active={active}
      />
    </section>
  );
}
