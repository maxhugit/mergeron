import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getProjectLocations } from '@/lib/project-locations-api';
import { AgentInstructionsDialog } from './agent-instructions-dialog';

/** Instructions remain available with no Git source and with the explorer closed. */
export function AgentInstructionsButton({
  threadId,
  projectId,
}: {
  threadId: string;
  projectId: string;
}) {
  const { t } = useTranslation('workspaces');
  const [open, setOpen] = useState(false);
  const inventory = useQuery({
    queryKey: ['agent-instruction-copies', projectId, threadId],
    queryFn: ({ signal }) => getProjectLocations(projectId, signal),
    enabled: open,
    retry: false,
  });
  return (
    <>
      <button
        type="button"
        className="h-10 shrink-0 px-3 hover:bg-accent"
        title={t('contextTitle')}
        aria-label={t('contextTitle')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <FileText className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <AgentInstructionsDialog
          threadId={threadId}
          copies={inventory.data?.copies ?? []}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
