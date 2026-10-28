import { Fragment, useState } from 'react';
import { Folder, GitBranch, KeyRound, Network, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DirectorySelectionTree } from '@/components/files/directory-selection-tree';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type ExternalType = 'git' | 'ssh' | 'sftp' | 'ftps' | 'ftp';
type SourceType = 'local' | ExternalType;

const emptyExternalForm = {
  name: '',
  address: '',
  rootPath: '/',
  accessMode: 'read_only',
  username: '',
  password: '',
  knownHosts: '',
  allowInsecure: false,
};

export interface ExternalWorkspaceInput {
  name: string;
  type: ExternalType;
  address: string;
  rootPath: string;
  accessMode: string;
  allowInsecure: boolean;
  secret?: {
    username: string;
    password: string;
    knownHosts: string;
  };
}

export function WorkspaceCreationDialog({
  open,
  pending,
  onClose,
  onCreateLocal,
  onCreateExternal,
}: {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onCreateLocal: (path: string) => void;
  onCreateExternal: (input: ExternalWorkspaceInput) => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<SourceType | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [form, setForm] = useState(emptyExternalForm);

  const sourceOptions: Array<{
    type: SourceType;
    label: string;
    description: string;
    icon: typeof Folder;
  }> = [
    {
      type: 'local',
      label: t('localFolder'),
      description: t('localFolderWorkspaceDescription'),
      icon: Folder,
    },
    {
      type: 'git',
      label: t('githubOrGitRepository'),
      description: t('gitWorkspaceDescription'),
      icon: GitBranch,
    },
    {
      type: 'ssh',
      label: 'SSH',
      description: t('sshWorkspaceDescription'),
      icon: KeyRound,
    },
    {
      type: 'sftp',
      label: 'SFTP',
      description: t('sftpWorkspaceDescription'),
      icon: Server,
    },
    {
      type: 'ftps',
      label: 'FTPS',
      description: t('ftpsWorkspaceDescription'),
      icon: Network,
    },
    {
      type: 'ftp',
      label: 'FTP',
      description: t('ftpWorkspaceDescription'),
      icon: Network,
    },
  ];
  const field =
    'h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground';
  const external = source && source !== 'local' ? source : null;
  const canSubmit =
    source === 'local'
      ? Boolean(selectedPath)
      : Boolean(external && form.name.trim() && form.address.trim());

  const submit = () => {
    if (source === 'local' && selectedPath) {
      onCreateLocal(selectedPath);
      return;
    }
    if (!external || !form.name.trim() || !form.address.trim()) return;
    const hasSecret = form.username || form.password || form.knownHosts;
    onCreateExternal({
      name: form.name.trim(),
      type: external,
      address: form.address.trim(),
      rootPath: form.rootPath.trim() || '/',
      accessMode: form.accessMode,
      allowInsecure: external === 'ftp' && form.allowInsecure,
      secret: hasSecret
        ? {
            username: form.username,
            password: form.password,
            knownHosts: form.knownHosts,
          }
        : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      {open && (
        <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] min-w-0 overflow-y-auto sm:max-w-2xl">
          <DialogHeader className="min-w-0 pr-8">
            <DialogTitle>{t('addAWorkspace')}</DialogTitle>
          </DialogHeader>

          {!source ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {sourceOptions.map((option, index) => {
                const Icon = option.icon;
                return (
                  <Fragment key={option.type}>
                    {index === 0 && (
                      <h3 className="col-span-full text-sm font-semibold">
                        {t('projectWorkspaces')}
                      </h3>
                    )}
                    {index === 1 && (
                      <h3 className="col-span-full mt-2 text-sm font-semibold">
                        {t('externalResources')}
                      </h3>
                    )}
                    <button
                      type="button"
                      className="flex min-w-0 items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent/40"
                      onClick={() => setSource(option.type)}
                    >
                      <span className="shrink-0 rounded-md bg-primary/10 p-2 text-primary">
                        <Icon className="h-5 w-5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block font-medium">
                          {option.label}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </span>
                    </button>
                  </Fragment>
                );
              })}
            </div>
          ) : source === 'local' ? (
            <div className="space-y-3">
              <Button variant="ghost" size="sm" onClick={() => setSource(null)}>
                ← {t('chooseAnotherSource')}
              </Button>
              <DirectorySelectionTree
                selectedPath={selectedPath}
                onSelectedPathChange={setSelectedPath}
                showCreateButton
              />
            </div>
          ) : (
            <div className="space-y-4">
              <Button variant="ghost" size="sm" onClick={() => setSource(null)}>
                ← {t('chooseAnotherSource')}
              </Button>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid min-w-0 gap-1 text-sm font-medium">
                  {t('connectionName')}
                  <input
                    className={field}
                    value={form.name}
                    onChange={(event) =>
                      setForm({ ...form, name: event.target.value })
                    }
                  />
                </label>
                <label className="grid min-w-0 gap-1 text-sm font-medium">
                  {t('connectionType')}
                  <select
                    className={field}
                    value={source}
                    onChange={(event) =>
                      setSource(event.target.value as ExternalType)
                    }
                  >
                    {sourceOptions.slice(1).map((option) => (
                      <option key={option.type} value={option.type}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid min-w-0 gap-1 text-sm font-medium sm:col-span-2">
                  {external === 'git'
                    ? t('repositoryUrl')
                    : t('connectionAddress')}
                  <input
                    className={field}
                    placeholder={
                      external === 'git'
                        ? 'https://github.com/organisation/repository.git'
                        : 'server.example.com:22'
                    }
                    value={form.address}
                    onChange={(event) =>
                      setForm({ ...form, address: event.target.value })
                    }
                  />
                </label>
                <label className="grid min-w-0 gap-1 text-sm font-medium">
                  {t('allowedRoot')}
                  <input
                    className={field}
                    value={form.rootPath}
                    onChange={(event) =>
                      setForm({ ...form, rootPath: event.target.value })
                    }
                  />
                </label>
                <label className="grid min-w-0 gap-1 text-sm font-medium">
                  {t('accessMode')}
                  <select
                    className={field}
                    value={form.accessMode}
                    onChange={(event) =>
                      setForm({ ...form, accessMode: event.target.value })
                    }
                  >
                    <option value="read_only">{t('readOnly')}</option>
                    <option value="read_write">{t('readAndWrite')}</option>
                  </select>
                </label>
                <label className="grid min-w-0 gap-1 text-sm font-medium">
                  {t('username')}
                  <input
                    className={field}
                    autoComplete="off"
                    value={form.username}
                    onChange={(event) =>
                      setForm({ ...form, username: event.target.value })
                    }
                  />
                </label>
                <label className="grid min-w-0 gap-1 text-sm font-medium">
                  {external === 'git' ? t('accessToken') : t('passwordOrToken')}
                  <input
                    className={field}
                    type="password"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(event) =>
                      setForm({ ...form, password: event.target.value })
                    }
                  />
                </label>
                {(external === 'ssh' || external === 'sftp') && (
                  <label className="grid min-w-0 gap-1 text-sm font-medium sm:col-span-2">
                    {t('knownHosts')}
                    <textarea
                      className="min-h-20 w-full min-w-0 resize-y rounded-md border border-input bg-background p-3 font-mono text-xs"
                      value={form.knownHosts}
                      onChange={(event) =>
                        setForm({ ...form, knownHosts: event.target.value })
                      }
                    />
                  </label>
                )}
                {external === 'ftp' && (
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={form.allowInsecure}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          allowInsecure: event.target.checked,
                        })
                      }
                    />
                    {t('allowPlainFtp')}
                  </label>
                )}
              </div>
              {external === 'git' && (
                <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                  {t('githubRepositoryConnectionHint')}
                </p>
              )}
            </div>
          )}

          <DialogFooter className="sm:flex-wrap">
            <Button variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
            {source && (
              <Button
                className="h-auto min-h-9 min-w-0 whitespace-normal text-center"
                disabled={pending || !canSubmit}
                onClick={submit}
              >
                {pending ? t('loading') : t('addAWorkspace')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
