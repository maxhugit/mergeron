import { translationKey } from '@/locales/translation-key';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { projectsApi } from '@/lib/projects-api';
import { SettingsPanelActions } from '@/components/settings/settings-panel';
import { KnowledgeProposalsPanel } from './knowledge-proposals-panel';

const names = ['AGENTS.md', 'CONNAISSANCES.md', 'DECISIONS.md'] as const;
type Files = Record<(typeof names)[number], string>;
type Snapshot = { files: Files; revision: string; path: string };
type Draft = { files: Files; revision: string };
const labels = [
  'Shared instructions',
  'Project knowledge',
  'Project decisions',
];
const descriptions = [
  'Stable rules and ways of working for all conversations in this project.',
  'Useful facts, definitions and references shared by the project.',
  'Agreed decisions, their reasons and any conditions for reconsidering them.',
];

export function ProjectKnowledgePanel({
  projectId,
  readOnly = false,
  view = 'all',
  active = true,
  selectedFile = 'AGENTS.md',
}: {
  projectId: string;
  readOnly?: boolean;
  view?: 'all' | 'memory' | 'proposals';
  active?: boolean;
  selectedFile?: string;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const key = ['project-knowledge', projectId];
  const draftKey = ['project-knowledge-draft', projectId];
  // Retain drafts when switching project tabs, with their original revision.
  const [draft, setDraft] = useState<Draft | null>(() => {
    client.setQueryDefaults(['project-knowledge-draft'], { gcTime: Infinity });
    return client.getQueryData<Draft | null>(draftKey) ?? null;
  });
  const [reloadError, setReloadError] = useState('');
  const [proposalBusy, setProposalBusy] = useState(false);
  const query = useQuery({
    queryKey: key,
    queryFn: () => projectsApi<Snapshot>(`/${projectId}/knowledge`),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const save = useMutation({
    mutationFn: (input: Draft) =>
      projectsApi<Snapshot>(`/${projectId}/knowledge`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: (snapshot) => {
      client.setQueryData(key, snapshot);
      client.setQueryData(draftKey, null);
      setDraft(null);
    },
  });
  const snapshot = query.data;
  const files = readOnly ? snapshot?.files : (draft?.files ?? snapshot?.files);
  const dirty =
    !!files &&
    !!snapshot &&
    names.some((name) => files[name] !== snapshot.files[name]);
  const tooLarge =
    !!files &&
    names.some((name) => new TextEncoder().encode(files[name]).length > 32768);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const reload = async () => {
    setReloadError('');
    const result = await query.refetch();
    if (result.error) setReloadError(result.error.message);
    else {
      client.setQueryData(draftKey, null);
      setDraft(null);
      save.reset();
    }
  };
  if (!snapshot || !files)
    return (
      <div role={query.error ? 'alert' : 'status'}>
        {query.error ? t('unableToLoadProjectKnowledge') : t('loading')}
        {query.error && (
          <Button onClick={() => void reload()}>{t('retry')}</Button>
        )}
      </div>
    );
  return (
    <section className="space-y-5 pb-3">
      <div hidden={view === 'proposals'}>
        <h3 className="font-semibold">{t('sharedProjectKnowledge')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            'theseFilesAreReadAtEachNewExchangeIncludingInSecondaryWorkspacesSavedChangesApp86cf98f9',
          )}
        </p>
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
          {snapshot.path}
        </p>
      </div>
      {names.map((name, index) => (
        <div
          key={name}
          hidden={
            view === 'proposals' || (view === 'memory' && selectedFile !== name)
          }
          className="space-y-2"
        >
          <label htmlFor={`knowledge-${name}`} className="block font-medium">
            {t(translationKey(labels[index]))}{' '}
            <span className="font-mono text-xs text-muted-foreground">
              {name}
            </span>
          </label>
          <p className="text-sm text-muted-foreground">
            {t(translationKey(descriptions[index]))}
          </p>
          <Textarea
            id={`knowledge-${name}`}
            rows={8}
            value={files[name]}
            readOnly={readOnly}
            disabled={save.isPending || proposalBusy}
            className="min-h-72 w-full font-mono text-sm"
            onChange={(event) => {
              const next = {
                files: { ...files, [name]: event.target.value },
                revision: draft?.revision ?? snapshot.revision,
              };
              setDraft(next);
              client.setQueryData<Draft>(draftKey, next);
            }}
          />
          <p className="text-xs text-muted-foreground">
            {new TextEncoder().encode(files[name]).length} / 32768 {t('bytes')}
          </p>
        </div>
      ))}
      {!readOnly && (
        <div hidden={view === 'memory'}>
          <KnowledgeProposalsPanel
            projectId={projectId}
            active={active && view !== 'memory'}
            revision={snapshot.revision}
            unsaved={dirty}
            onBusyChange={setProposalBusy}
            onApplied={() => {
              setDraft(null);
              client.setQueryData(draftKey, null);
              void client.invalidateQueries({ queryKey: key });
            }}
          />
        </div>
      )}
      {save.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(
            'unableToSaveProjectKnowledgeIfAnotherEditWasSavedReloadBeforeTryingAgainYourDra8e2b12e6',
          )}{' '}
        </p>
      )}
      {reloadError && (
        <p role="alert" className="text-sm text-destructive">
          {t('unableToLoadProjectKnowledge')}
        </p>
      )}
      {tooLarge && (
        <p role="alert" className="text-sm text-destructive">
          {t('eachKnowledgeFileIsLimitedTo32KiBOfUtf8Text')}
        </p>
      )}
      {!readOnly && (
        <SettingsPanelActions active={active && view !== 'proposals'}>
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <span role="status" className="text-sm text-muted-foreground">
              {dirty ? t('unsavedChanges') : t('noPendingChanges')}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={save.isPending || proposalBusy || query.isFetching}
                onClick={() => void reload()}
              >
                {dirty ? t('reloadAndDiscardChanges') : t('reload')}
              </Button>
              <Button
                variant="outline"
                disabled={!dirty || save.isPending || proposalBusy}
                onClick={() => {
                  setDraft(null);
                  client.setQueryData(draftKey, null);
                  save.reset();
                }}
              >
                {t('cancel')}
              </Button>
              <Button
                disabled={!dirty || tooLarge || save.isPending || proposalBusy}
                onClick={() =>
                  save.mutate({
                    files,
                    revision: draft?.revision ?? snapshot.revision,
                  })
                }
              >
                {save.isPending ? t('saving56a2285c') : t('save')}
              </Button>
            </div>
          </div>
        </SettingsPanelActions>
      )}
    </section>
  );
}
