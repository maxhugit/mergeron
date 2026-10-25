import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { usePlatformSession } from '@/lib/platform-session';
import { ProjectArchiveImportForm } from '@/components/projects/project-archive-transfer';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface CreateProjectDialogProps {
  open: boolean;
  pending: boolean;
  name: string;
  onNameChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}

/** The primary workspace path is assigned by the server. */
export function CreateProjectDialog({
  open,
  pending,
  name,
  onNameChange,
  onSave,
  onClose,
}: CreateProjectDialogProps) {
  const { t } = useTranslation(['common', 'projectArchives'], {
    nsMode: 'fallback',
  });
  const session = usePlatformSession();
  const [mode, setMode] = useState<'new' | 'import'>('new');
  const [importBusy, setImportBusy] = useState(false);
  const close = () => {
    setMode('new');
    setImportBusy(false);
    onClose();
  };
  const canSave = Boolean(name.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending && !importBusy) {
          close();
        }
      }}
    >
      {open && (
        <DialogContent className="max-h-[85dvh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('createAProject')}</DialogTitle>
            <DialogDescription>
              {t(
                mode === 'import' && session.isAdministrator
                  ? 'projectArchiveImportDescription'
                  : 'aPermanentPrimaryWorkspaceIsCreatedAutomaticallyAtWorkspacesProjectIdYouCanAtta8d03ff7d',
              )}
            </DialogDescription>
          </DialogHeader>
          {session.isAdministrator && (
            <div
              role="tablist"
              aria-label={t('createAProject')}
              className="flex gap-2 border-b pb-2"
            >
              <Button
                id="project-new-tab"
                role="tab"
                aria-selected={mode === 'new'}
                aria-controls="project-new-panel"
                variant={mode === 'new' ? 'secondary' : 'ghost'}
                disabled={pending || importBusy}
                onClick={() => setMode('new')}
              >
                {t('newProject')}
              </Button>
              <Button
                id="project-import-tab"
                role="tab"
                aria-selected={mode === 'import'}
                aria-controls="project-import-panel"
                variant={mode === 'import' ? 'secondary' : 'ghost'}
                disabled={pending || importBusy}
                onClick={() => setMode('import')}
              >
                {t('projectArchiveImport')}
              </Button>
            </div>
          )}
          {mode === 'import' && session.isAdministrator ? (
            <ProjectArchiveImportForm
              onBusyChange={setImportBusy}
              onImported={close}
              onCancel={close}
            />
          ) : (
            <div
              role="tabpanel"
              className="space-y-4"
              id="project-new-panel"
              aria-labelledby={
                session.isAdministrator ? 'project-new-tab' : undefined
              }
            >
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="new-project-name"
                    className="text-sm font-medium"
                  >
                    {t('projectName')}
                  </label>
                  <Input
                    id="new-project-name"
                    value={name}
                    onChange={(event) => onNameChange(event.target.value)}
                    disabled={pending}
                    autoFocus
                  />
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" disabled={pending} onClick={close}>
                  {t('cancel')}
                </Button>
                <Button disabled={!canSave || pending} onClick={onSave}>
                  {pending && (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  )}
                  {t('create')}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
