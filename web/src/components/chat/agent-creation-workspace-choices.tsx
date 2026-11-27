import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { agentCreationWorkspaces } from '@/lib/agent-creation-workspaces';
import type { ProjectWorkspaceSummary } from '@/lib/projects-api';

export function AgentCreationWorkspaceChoices({
  workspaces,
  onSelect,
}: {
  workspaces: ProjectWorkspaceSummary[];
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-w-0 gap-2">
      {agentCreationWorkspaces(workspaces).map((workspace) => (
        <Button
          key={workspace.id}
          variant={workspace.primary ? 'secondary' : 'outline'}
          className="min-w-0 justify-start"
          onClick={() => onSelect(workspace.path)}
        >
          <FolderOpen className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">
            {workspace.primary ? t('primaryWorkspace') : workspace.name}
          </span>
        </Button>
      ))}
    </div>
  );
}
