import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { usePlatformSession } from '@/lib/platform-session';
import {
  projectsApi,
  projectsQueryKey,
  type ProjectSummary,
} from '@/lib/projects-api';

export function ProjectDescription({ project }: { project: ProjectSummary }) {
  const { t } = useTranslation();
  const session = usePlatformSession();
  const client = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? project.description ?? '';
  const save = useMutation({
    mutationFn: (description: string) =>
      projectsApi(`/${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ description }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: projectsQueryKey });
      setDraft(null);
    },
  });
  return (
    <section className="mb-4 space-y-2 rounded-lg border p-4">
      <label
        htmlFor={`project-description-${project.id}`}
        className="text-sm font-medium"
      >
        {t('projectShortDescription')}
      </label>
      {session.isAdministrator ? (
        <>
          <Textarea
            id={`project-description-${project.id}`}
            rows={4}
            maxLength={1000}
            value={value}
            disabled={save.isPending}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t('projectShortDescriptionHint')}
          </p>
          {save.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t('unableToSaveProject')}
            </p>
          )}
          <Button
            disabled={save.isPending || value === (project.description ?? '')}
            onClick={() => save.mutate(value)}
          >
            {t('save')}
          </Button>
        </>
      ) : (
        <p className="whitespace-pre-wrap text-sm">
          {project.description || '—'}
        </p>
      )}
    </section>
  );
}
