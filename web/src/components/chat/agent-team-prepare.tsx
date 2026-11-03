import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  readTeamProfiles,
  saveTeamProfiles,
  prepareAgentTeam,
  type TeamProfile,
} from '@/lib/agent-teams-api';
import { getApiErrorMessage } from '@/lib/api-error';

export function AgentTeamPrepare({
  projectId,
  coordinator,
  onPrepared,
}: {
  projectId: string;
  coordinator: string;
  onPrepared: (id: string) => void;
}) {
  const { t } = useTranslation('teams');
  const [open, setOpen] = useState(false),
    [objective, setObjective] = useState(''),
    [edited, setEdited] = useState<TeamProfile[] | null>(null),
    [receipt, setReceipt] = useState(() => crypto.randomUUID());
  const query = useQuery({
    queryKey: ['team-profiles', projectId, coordinator],
    queryFn: ({ signal }) => readTeamProfiles(projectId, coordinator, signal),
    enabled: open,
  });
  const profiles = edited ?? query.data ?? [];
  const save = useMutation({
    mutationFn: () => saveTeamProfiles(projectId, coordinator, profiles),
    retry: false,
  });
  const prepare = useMutation({
    mutationFn: () =>
      prepareAgentTeam(projectId, coordinator, {
        requestId: receipt,
        objective,
        profiles,
      }),
    retry: false,
    onSuccess: (team) => {
      onPrepared(team.id);
      setOpen(false);
      setReceipt(crypto.randomUUID());
      setObjective('');
    },
  });
  const change = (next: TeamProfile[]) => {
    setEdited(next);
    setReceipt(crypto.randomUUID());
    prepare.reset();
    save.reset();
  };
  if (!open)
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('prepareTeam')}
      </Button>
    );
  return (
    <div className="space-y-3 rounded-md border p-3">
      <h3 className="font-medium">{t('prepareTeam')}</h3>
      <p className="text-xs text-muted-foreground">{t('launchSafeguards')}</p>
      <label className="block space-y-1">
        <span>{t('objective')}</span>
        <Textarea
          maxLength={6000}
          value={objective}
          onChange={(e) => {
            setObjective(e.target.value);
            setReceipt(crypto.randomUUID());
            prepare.reset();
          }}
        />
      </label>
      {query.isPending && <p role="status">{t('loading')}</p>}
      {query.isError && <p role="alert">{getApiErrorMessage(query.error)}</p>}
      {profiles.map((profile, index) => (
        <fieldset key={profile.key} className="min-w-0 space-y-2 border-t pt-2">
          <label className="block space-y-1">
            <span>{t('roleName')}</span>
            <Input
              maxLength={120}
              value={profile.role}
              onChange={(e) =>
                change(
                  profiles.map((p, i) =>
                    i === index ? { ...p, role: e.target.value } : p,
                  ),
                )
              }
            />
          </label>
          <label className="block space-y-1">
            <span>{t('instructions')}</span>
            <Textarea
              maxLength={6000}
              value={profile.instructions}
              onChange={(e) =>
                change(
                  profiles.map((p, i) =>
                    i === index ? { ...p, instructions: e.target.value } : p,
                  ),
                )
              }
            />
          </label>
          <p className="text-xs">{t('chooseDependencies')}</p>
          {profiles
            .filter((p) => p.key !== profile.key)
            .map((other) => (
              <label
                key={other.key}
                className="flex items-center gap-2 text-xs"
              >
                <input
                  type="checkbox"
                  checked={profile.dependencies.includes(other.key)}
                  onChange={(e) =>
                    change(
                      profiles.map((p, i) =>
                        i === index
                          ? {
                              ...p,
                              dependencies: e.target.checked
                                ? [...p.dependencies, other.key]
                                : p.dependencies.filter(
                                    (key) => key !== other.key,
                                  ),
                            }
                          : p,
                      ),
                    )
                  }
                />
                {other.role}
              </label>
            ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={profiles.length <= 1}
            onClick={() =>
              change(
                profiles
                  .filter((p) => p.key !== profile.key)
                  .map((p) => ({
                    ...p,
                    dependencies: p.dependencies.filter(
                      (key) => key !== profile.key,
                    ),
                  })),
              )
            }
          >
            {t('removeRole')}
          </Button>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={profiles.length >= 12 || query.isError || query.isPending}
          onClick={() =>
            change([
              ...profiles,
              {
                key: crypto.randomUUID(),
                role: '',
                instructions: '',
                dependencies: [],
              },
            ])
          }
        >
          {t('addRole')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={save.isPending || !profiles.length || prepare.isPending}
          onClick={() => save.mutate()}
        >
          {t('saveProfiles')}
        </Button>
      </div>
      {save.isSuccess && <p role="status">{t('profilesSaved')}</p>}
      {(save.isError || prepare.isError) && (
        <p role="alert" className="break-words text-destructive">
          {getApiErrorMessage(prepare.error ?? save.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            !objective.trim() ||
            !profiles.length ||
            query.isError ||
            prepare.isPending
          }
          onClick={() => prepare.mutate()}
        >
          {t('reviewPlan')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={prepare.isPending}
          onClick={() => setOpen(false)}
        >
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
