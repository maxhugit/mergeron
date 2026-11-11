import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PreviewSource } from '../../../../runtime/preview-profile.cjs';
import { projectsApi } from '@/lib/projects-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface PreviewSources {
  source: PreviewSource;
  revision: string | null;
  copies: (Extract<PreviewSource, { type: 'git_copy' }> & {
    name?: string;
    branch?: string | null;
  })[];
}
export function PreviewSourceSelect({
  projectId,
  threadId,
  sources,
  disabled,
}: {
  projectId: string;
  threadId: string;
  sources: PreviewSources;
  disabled: boolean;
}) {
  const { t } = useTranslation('previews');
  const client = useQueryClient();
  const [source, setSource] = useState(sources.source);
  const mutation = useMutation({
    mutationFn: () =>
      projectsApi(`/${projectId}/agents/${threadId}/preview/source`, {
        method: 'PUT',
        body: JSON.stringify({ source, expectedRevision: sources.revision }),
      }),
    onSettled: () =>
      client.invalidateQueries({
        queryKey: ['agent-preview', projectId, threadId],
      }),
  });
  return (
    <form
      className="flex shrink-0 flex-wrap items-end gap-2 border-b px-3 py-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <label className="flex min-w-0 flex-1 basis-full flex-col gap-1 @xl:basis-0">
        {t('source.label')}
        <select
          aria-label={t('source.label')}
          className="h-8 min-w-0 rounded border bg-background px-2"
          disabled={disabled || mutation.isPending}
          value={source.type === 'git_copy' ? source.copyId : 'agent_reference'}
          onChange={(e) => {
            const copy = sources.copies.find(
              (c) => c.copyId === e.target.value,
            );
            setSource(
              copy
                ? {
                    type: 'git_copy',
                    connectionId: copy.connectionId,
                    copyId: copy.copyId,
                    subdirectory: '.',
                  }
                : { type: 'agent_reference' },
            );
          }}
        >
          <option value="agent_reference">{t('source.agentReference')}</option>
          {sources.copies.map((c) => (
            <option key={c.copyId} value={c.copyId}>
              {c.name
                ? c.name + (c.branch ? ' · ' + c.branch : '')
                : t('source.gitCopy', { id: c.copyId })}
            </option>
          ))}
        </select>
      </label>
      {source.type === 'git_copy' && (
        <label className="flex flex-col gap-1">
          {t('source.subdirectory')}
          <Input
            className="h-8 w-36"
            disabled={disabled || mutation.isPending}
            value={source.subdirectory}
            onChange={(e) =>
              setSource({ ...source, subdirectory: e.target.value })
            }
          />
        </label>
      )}
      <Button type="submit" size="sm" disabled={disabled || mutation.isPending}>
        {t('source.apply')}
      </Button>
      <p className="w-full text-muted-foreground">
        {t(disabled ? 'source.stopFirst' : 'source.localOnly')}
      </p>
      {mutation.isError && (
        <p role="alert" className="w-full text-destructive">
          {t('source.failed')}
        </p>
      )}
    </form>
  );
}
