import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { projectsApi } from '@/lib/projects-api';
import { withBasePath } from '@/base-path';
import { SettingsPanelActions } from '@/components/settings/settings-panel';

interface Proposal {
  id: string;
  title: string;
  file: string;
  status: 'pending' | 'accepted' | 'rejected';
  version: number;
  sourceType: 'agent' | 'retired';
  threadId: string;
  createdAt: number;
  reviewedAt: number | null;
  reviewer: string | null;
  baseRevision: string;
}
interface Detail extends Proposal {
  baseFiles: Record<string, string>;
  proposedFiles: Record<string, string>;
}
type Props = {
  projectId: string;
  revision: string;
  unsaved: boolean;
  active?: boolean;
  onApplied: () => void;
  onBusyChange?: (busy: boolean) => void;
};

/** Every proposal is expanded. Each editor owns its draft and original version. */
export function KnowledgeProposalsPanel({
  active = true,
  onBusyChange,
  ...props
}: Props) {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const busy = busyIds.size > 0;
  const query = useQuery({
    queryKey: ['knowledge-proposals', props.projectId, offset],
    queryFn: () =>
      projectsApi<{ proposals: Proposal[]; nextOffset: number | null }>(
        `/${props.projectId}/knowledge/proposals?offset=${offset}`,
      ),
    enabled: active,
    refetchInterval: active && !busy ? 10000 : false,
    refetchOnWindowFocus: false,
  });
  const client = useQueryClient();
  const setBusy = useCallback(
    (id: string, value: boolean) =>
      setBusyIds((current) => {
        const next = new Set(current);
        if (value) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h3 className="font-semibold">{t('memoryProposals')}</h3>
        <p className="text-sm text-muted-foreground">
          {t(
            'agentsCanSuggestLastingFactsOrDecisionsOnlyAcceptedProposalsChangeSharedKnowledbe771c56',
          )}
        </p>
      </div>
      {query.isPending && active && <p role="status">{t('loading')}</p>}
      {query.error && <p role="alert">{t('unableToLoadMemoryProposals')}</p>}
      {!query.isPending && !query.error && !query.data?.proposals?.length && (
        <p className="text-sm text-muted-foreground">
          {t('noMemoryProposals')}
        </p>
      )}
      {query.data?.proposals?.map((item) => (
        <ProposalReview
          key={item.id}
          {...props}
          item={item}
          active={active}
          blocked={busy && !busyIds.has(item.id)}
          onBusy={setBusy}
        />
      ))}
      <SettingsPanelActions active={active}>
        <Button
          variant="outline"
          disabled={busy || query.isFetching}
          onClick={() => {
            void query.refetch();
            void client.invalidateQueries({
              queryKey: ['knowledge-proposal', props.projectId],
            });
          }}
        >
          {t('reload')}
        </Button>
        <Button
          variant="ghost"
          disabled={!offset || busy}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          {t('previous')}
        </Button>
        <Button
          variant="ghost"
          disabled={query.data?.nextOffset == null || busy}
          onClick={() => setOffset(query.data?.nextOffset ?? offset)}
        >
          {t('next')}
        </Button>
      </SettingsPanelActions>
    </section>
  );
}

function ProposalReview({
  projectId,
  revision,
  unsaved,
  onApplied,
  active,
  item,
  blocked,
  onBusy,
}: Omit<Props, 'onBusyChange'> & {
  item: Proposal;
  blocked: boolean;
  onBusy: (id: string, busy: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  // Keep a draft across sub-tab changes and refetches, paired with its source version.
  const draftKey = ['knowledge-proposal-draft', projectId, item.id];
  const [draft, setDraft] = useState<{
    content: string;
    version: number;
  } | null>(() => client.getQueryData(draftKey) ?? null);
  const detail = useQuery({
    queryKey: ['knowledge-proposal', projectId, item.id],
    queryFn: () =>
      projectsApi<Detail>(`/${projectId}/knowledge/proposals/${item.id}`),
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 30000,
  });
  const review = useMutation({
    mutationFn: ({
      action,
      proposal,
    }: {
      action: 'edit' | 'accept' | 'reject';
      proposal: Detail;
    }) =>
      projectsApi<Detail>(`/${projectId}/knowledge/proposals/${proposal.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action,
          version:
            action === 'edit'
              ? (draft?.version ?? proposal.version)
              : proposal.version,
          ...(action === 'edit'
            ? {
                content:
                  draft?.content ?? proposal.proposedFiles[proposal.file],
              }
            : {}),
        }),
      }),
    onSuccess: async (proposal, input) => {
      client.setQueryData(
        ['knowledge-proposal', projectId, proposal.id],
        proposal,
      );
      client.removeQueries({ queryKey: draftKey, exact: true });
      setDraft(null);
      if (input.action === 'accept') onApplied();
      await client.invalidateQueries({
        queryKey: ['knowledge-proposals', projectId],
      });
    },
  });
  useEffect(() => {
    onBusy(item.id, review.isPending);
    return () => onBusy(item.id, false);
  }, [item.id, review.isPending, onBusy]);
  const proposal = detail.data;
  const displayed = proposal ?? item;
  const proposed =
    (proposal?.status === 'pending' ? draft?.content : null) ??
    proposal?.proposedFiles[proposal.file] ??
    '';
  const changed =
    !!proposal && proposed !== proposal.proposedFiles[proposal.file];
  const stale =
    !!proposal &&
    (proposal.baseRevision !== revision ||
      (!!draft && draft.version !== proposal.version));
  const tooLarge = new TextEncoder().encode(proposed).length > 32768;
  const date = (value: number) => new Date(value).toLocaleString(i18n.language);
  return (
    <article
      className="space-y-4 border-b pb-6 last:border-b-0"
      aria-label={item.title}
    >
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-medium">{item.title}</h4>
          <span className="text-xs">
            {t(
              displayed.status === 'pending'
                ? 'pendingReview'
                : displayed.status === 'accepted'
                  ? 'accepted'
                  : 'rejected',
            )}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {item.file} · {date(item.createdAt)}
        </p>
        {item.sourceType === 'agent' && (
          <a
            className="block break-all text-sm underline"
            href={withBasePath(`/t/${encodeURIComponent(item.threadId)}`)}
          >
            {t('openSourceConversation')} · {item.threadId}
          </a>
        )}
        {displayed.reviewedAt && (
          <p className="text-xs text-muted-foreground">
            {displayed.reviewer} · {date(displayed.reviewedAt)}
          </p>
        )}
      </div>
      {detail.isPending && <p role="status">{t('loading')}</p>}
      {detail.error && (
        <div role="alert">
          <p>{t('unableToLoadMemoryProposals')}</p>
          <Button variant="outline" onClick={() => void detail.refetch()}>
            {t('retry')}
          </Button>
        </div>
      )}
      {proposal && (
        <>
          <label
            className="grid gap-2 text-sm font-medium"
            htmlFor={`before-${item.id}`}
          >
            {t('beforeProposal')}
            <Textarea
              id={`before-${item.id}`}
              readOnly
              rows={8}
              value={proposal.baseFiles[proposal.file]}
              className="min-h-40 w-full font-mono text-sm"
            />
          </label>
          <label
            className="grid gap-2 text-sm font-medium"
            htmlFor={`after-${item.id}`}
          >
            {t('proposedContent')}
            <Textarea
              id={`after-${item.id}`}
              readOnly={proposal.status !== 'pending'}
              disabled={review.isPending || blocked}
              rows={8}
              value={proposed}
              onChange={(event) => {
                const next = {
                  content: event.target.value,
                  version: draft?.version ?? proposal.version,
                };
                setDraft(next);
                client.setQueryDefaults(['knowledge-proposal-draft'], {
                  gcTime: Infinity,
                });
                client.setQueryData(draftKey, next);
              }}
              className="min-h-48 w-full font-mono text-sm"
            />
          </label>
          {stale && proposal.status === 'pending' && (
            <p role="alert" className="text-sm text-destructive">
              {t(
                'sharedKnowledgeHasChangedRejectThisOutdatedProposalAndAskTheConversationForANew6e73ab19',
              )}
            </p>
          )}
          {unsaved && (
            <p className="text-sm text-muted-foreground">
              {t('saveOrDiscardYourKnowledgeDraftBeforeAcceptingAProposal')}
            </p>
          )}
          {tooLarge && (
            <p role="alert">
              {t('eachKnowledgeFileIsLimitedTo32KiBOfUtf8Text')}
            </p>
          )}
          {review.error && (
            <p role="alert" className="text-sm text-destructive">
              {t(
                'theProposalCouldNotBeUpdatedReloadToCheckItsVersionYourLocalChangesHaveBeenKept',
              )}
            </p>
          )}
          {proposal.status === 'pending' && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={
                  !changed || stale || tooLarge || review.isPending || blocked
                }
                onClick={() => review.mutate({ action: 'edit', proposal })}
              >
                {t('saveProposalChanges')}
              </Button>
              <Button
                disabled={
                  changed ||
                  stale ||
                  tooLarge ||
                  unsaved ||
                  review.isPending ||
                  blocked
                }
                onClick={() => review.mutate({ action: 'accept', proposal })}
              >
                {t('acceptAndApply')}
              </Button>
              <Button
                variant="outline"
                disabled={review.isPending || blocked}
                onClick={() => review.mutate({ action: 'reject', proposal })}
              >
                {t('reject')}
              </Button>
            </div>
          )}
        </>
      )}
    </article>
  );
}
