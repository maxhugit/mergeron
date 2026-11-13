import { useSidebarPreferences } from '@/hooks/use-sidebar-preferences';
import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  PanelsTopLeft,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFileWatch } from '@/hooks/use-file-watch';
import { useAgentDocumentView } from '@/hooks/use-agent-document-view';
import { useDocumentOrganization } from '@/lib/document-organization';
import type { Deliverable, DeliverableDocument } from '@/lib/deliverables-api';
import { DeliverableDocuments } from '@/components/projects/deliverable-documents';
import { showSnackbar } from '@/stores/snackbar-store';
import type { DeliverableGitState } from '@/lib/deliverable-git-state';

/** Registered documents only: no filesystem navigation or general-purpose mutations. */
export function ExplorerDeliverableDocuments({
  item,
  base,
  personId,
  agentThreadId,
  onFile,
  refresh,
  hideDisplayControl = false,
  documentState,
  onSynchronize,
}: {
  hideDisplayControl?: boolean;
  documentState?: (document: DeliverableDocument) => DeliverableGitState;
  onSynchronize?: (document: DeliverableDocument) => void;
  item: Deliverable;
  base: string;
  personId?: string | null;
  agentThreadId?: string;
  onFile: (path: string) => void;
  refresh: () => Promise<unknown>;
}) {
  useFileWatch(item.directory);
  const { t } = useTranslation('deliverables');
  const { t: common } = useTranslation();
  const { t: workspaces } = useTranslation('workspaces');
  const preference = useAgentDocumentView(personId, agentThreadId);
  const organization = useDocumentOrganization(
    preference.mode === 'labels' ? base : undefined,
    item.id,
    item.version,
  );
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const disclosure = useSidebarPreferences(personId, agentThreadId);
  const isOpened = (id: string) =>
    personId && agentThreadId
      ? disclosure.values[`open:label:${item.id}:${id}`] === true
      : !!opened[id];
  const documents = item.documents.filter(
    (document) => document.deletedAt === null,
  );
  const row = (document: DeliverableDocument) => {
    const state = documentState?.(document);
    const issue =
      state === 'error'
        ? 'error'
        : state === 'pending' || state === 'waiting' || state === 'review'
          ? 'pending'
          : null;
    const hint =
      state === 'error'
        ? workspaces('deliverableGitDocumentError')
        : state === 'review'
          ? workspaces('deliverableGitDocumentReview')
          : state === 'waiting'
            ? workspaces('deliverableGitStateWaiting')
            : state === 'pending'
              ? workspaces('deliverableGitDocumentPending')
              : undefined;
    const Version = issue && onSynchronize ? 'button' : 'span';
    return (
      <DeliverableDocuments
        key={document.id}
        item={item}
        base={base}
        contextDocument={document}
        disabled={!['draft', 'in_constitution'].includes(item.lifecycleStatus)}
        refresh={refresh}
        onAttachToChat={() =>
          window.dispatchEvent(
            new CustomEvent('codex-webui:attach-file', {
              detail: { name: document.name, path: document.sourcePath },
            }),
          )
        }
        menuLabel={document.name}
        onError={() => showSnackbar(common('unableToUpdateDocument'), 'error')}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 text-xs">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded py-2 text-left text-xs hover:bg-muted"
            onClick={() => onFile(document.sourcePath)}
            title={document.name}
          >
            {/\.html?$/i.test(document.name) ||
            /^mockup-.*\.zip$/i.test(document.name) ? (
              <PanelsTopLeft className="h-4 w-4 shrink-0 text-primary" />
            ) : (
              <FileText className="h-4 w-4 shrink-0 text-primary" />
            )}
            <span className="min-w-0 flex-1 truncate">{document.name}</span>
          </button>
          <Version
            {...(issue && onSynchronize
              ? {
                  type: 'button' as const,
                  onClick: () => onSynchronize(document),
                }
              : {})}
            className={`shrink-0 rounded px-1.5 py-0.5 font-mono ${issue === 'error' ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200' : issue === 'pending' ? 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200' : 'bg-muted text-muted-foreground'}`}
            title={hint}
            aria-label={
              common('versionNumber', {
                number: document.currentVersionNumber,
              }) + (hint ? ` · ${hint}` : '')
            }
          >
            V{document.currentVersionNumber}
          </Version>
        </div>
      </DeliverableDocuments>
    );
  };
  const group = (id: string, name: string, members: DeliverableDocument[]) => (
    <section key={id}>
      <button
        type="button"
        aria-expanded={isOpened(id)}
        disabled={
          !!personId &&
          !!agentThreadId &&
          (!disclosure.ready || disclosure.pending)
        }
        className="flex w-full items-center gap-2 px-2 py-2 text-left text-xs hover:bg-muted"
        onClick={() => {
          if (personId && agentThreadId)
            disclosure.set(`open:label:${item.id}:${id}`, !isOpened(id));
          else setOpened((previous) => ({ ...previous, [id]: !previous[id] }));
        }}
      >
        {isOpened(id) ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <Folder className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="text-muted-foreground">{members.length}</span>
      </button>
      {isOpened(id) && (
        <div className="ml-3 border-l">
          {members.length ? (
            members.map(row)
          ) : (
            <p className="p-2 text-xs text-muted-foreground">
              {t('labelsEmpty')}
            </p>
          )}
        </div>
      )}
    </section>
  );
  return (
    <div className="min-w-0 p-1">
      {preference.available && !hideDisplayControl && (
        <div className="border-b px-2 py-2">
          <label className="flex flex-wrap items-center justify-between gap-2 text-xs">
            {t('labelsExplorerDisplay')}
            <select
              aria-label={t('labelsExplorerDisplay')}
              value={preference.mode}
              disabled={preference.loading}
              onChange={(event) =>
                preference.setMode(event.target.value as 'plain' | 'labels')
              }
              className="min-w-0 rounded-md border bg-background px-2 py-1"
            >
              <option value="plain">{t('labelsExplorerPlain')}</option>
              <option value="labels">{t('labelsExplorerVirtual')}</option>
            </select>
          </label>
          {preference.error && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {t('labelsPreferenceFailed')}
            </p>
          )}
        </div>
      )}
      {preference.mode !== 'labels' ? (
        documents.map(row)
      ) : organization.isLoading ? (
        <Loader2
          className="m-2 h-4 w-4 animate-spin"
          aria-label={t('explorerLoading')}
        />
      ) : organization.isError ? (
        <p role="alert" className="p-2 text-xs text-destructive">
          {t('labelsError')}
        </p>
      ) : (
        organization.data && (
          <>
            {organization.data.labels.map((label) =>
              group(
                'label:' + label.id,
                label.name,
                documents.filter((document) =>
                  organization.data!.assignments[document.id]?.includes(
                    label.id,
                  ),
                ),
              ),
            )}
            {group(
              'unassigned',
              t('labelsUnassigned'),
              documents.filter(
                (document) =>
                  !organization.data!.assignments[document.id]?.length,
              ),
            )}
          </>
        )
      )}
      {!documents.length && (
        <p className="p-2 text-xs text-muted-foreground">
          {common('noDocumentYet')}
        </p>
      )}
    </div>
  );
}
