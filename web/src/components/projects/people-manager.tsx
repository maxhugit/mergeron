import { translationKey } from '@/locales/translation-key';
import {
  TestAsPersonButton,
  ImpersonationAuditButton,
} from '@/components/impersonation-controls';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  LogOut,
  Pencil,
  Plus,
  UserRound,
  UserPlus,
  MoreHorizontal,
} from 'lucide-react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { projectsApi } from '@/lib/projects-api';
import { platformSessionKey } from '@/lib/platform-session';
import {
  authRequest,
  localAccountsKey,
  readLocalAccounts,
  type LocalAccount,
} from '@/lib/auth-api';
import {
  usePeople,
  useParticipants,
  peopleKey,
  personLabel,
  type Person,
  type Participant,
} from '@/lib/people-api';

export function ResponsiblePerson({ id }: { id: string | null | undefined }) {
  const { t } = useTranslation();
  const people = usePeople();
  const person = people.data?.people.find((p) => p.id === id);
  if (!id) return null;
  return (
    <span
      className="inline-flex max-w-40 items-center gap-1 truncate text-[10px] text-muted-foreground"
      title={`${t('responsiblePerson')}: ${person ? personLabel(person) : t('unknownPerson')}`}
    >
      <UserRound className="h-3 w-3 shrink-0" />
      <span className="truncate">
        {person ? personLabel(person) : t('unknownPerson')}
      </span>
    </span>
  );
}

export function PeopleManager({
  projectId,
  readOnly = false,
  showHeading = true,
  mode = 'full',
}: {
  projectId?: string;
  readOnly?: boolean;
  showHeading?: boolean;
  mode?: 'full' | 'activeAdministrators';
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const people = usePeople();
  const participants = useParticipants(projectId ?? '');
  const localAccounts = useQuery({
    queryKey: localAccountsKey,
    queryFn: readLocalAccounts,
    enabled: !projectId,
    refetchInterval: 30_000,
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<{
    reference: string;
    firstName: string;
    lastName: string;
    phone: string;
    role: 'standard' | 'administrator';
    email: string;
    active: boolean;
  } | null>(null);
  const [localAccountDraft, setLocalAccountDraft] = useState<{
    username: string;
    password: string;
  } | null>(null);
  const [removing, setRemoving] = useState<{
    person: Person;
    member: Participant;
  } | null>(null);
  const [search, setSearch] = useState('');
  const mutation = useMutation({
    mutationFn: ({
      path,
      method,
      body,
      localAccount,
    }: {
      path: string;
      method: string;
      body?: unknown;
      localAccount?: {
        personId?: string;
        username: string;
        password: string;
      };
    }) =>
      projectsApi(path, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }).then(async (result) => {
        if (localAccount) {
          const personId =
            localAccount.personId ??
            (result as { person?: { id?: string } } | undefined)?.person?.id;
          if (!personId) throw new Error('Unknown person');
          await authRequest(`local-accounts/${encodeURIComponent(personId)}`, {
            method: 'PUT',
            body: JSON.stringify({
              username: localAccount.username,
              ...(localAccount.password
                ? { password: localAccount.password }
                : {}),
            }),
          });
        }
        return result;
      }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: peopleKey }),
        client.invalidateQueries({ queryKey: platformSessionKey }),
        client.invalidateQueries({ queryKey: ['project-participants'] }),
        client.invalidateQueries({ queryKey: localAccountsKey }),
      ]);
      setForm(null);
      setLocalAccountDraft(null);
      setRemoving(null);
    },
  });
  const revokeSessions = useMutation({
    mutationFn: (personId: string) =>
      authRequest<{ revoked: true }>(
        `sessions/${encodeURIComponent(personId)}/revoke`,
        { method: 'POST' },
      ),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: localAccountsKey }),
        client.invalidateQueries({ queryKey: platformSessionKey }),
      ]);
    },
  });
  const participantIds = new Set(
    (participants.data?.participants ?? []).map((member) => member.personId),
  );
  const rows = (people.data?.people ?? []).filter(
    (person) =>
      (!projectId || !readOnly || participantIds.has(person.id)) &&
      (mode !== 'activeAdministrators' ||
        (person.active && person.role === 'administrator')) &&
      `${person.name} ${person.reference} ${person.email ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const editPerson = (person: Person, account?: LocalAccount) => {
    mutation.reset();
    setEditing(person.id);
    setForm({
      reference: person.reference,
      firstName: person.firstName ?? '',
      lastName: person.lastName ?? '',
      phone: person.phone ?? '',
      role: person.role ?? 'standard',
      email: person.email ?? '',
      active: person.active,
    });
    setLocalAccountDraft({
      username: account?.username ?? '',
      password: '',
    });
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (form) {
      const account = localAccounts.data?.accounts.find(
        (item) => item.personId === editing,
      );
      const shouldSaveLocalAccount =
        Boolean(localAccountDraft && !account?.oidcLinked) &&
        Boolean(account?.passwordConfigured || localAccountDraft?.password);
      mutation.mutate({
        path: editing ? `/people/${editing}` : '/people',
        method: editing ? 'PATCH' : 'POST',
        body: form,
        ...(shouldSaveLocalAccount && localAccountDraft
          ? {
              localAccount: {
                ...(editing ? { personId: editing } : {}),
                ...localAccountDraft,
              },
            }
          : {}),
      });
    }
  };
  return (
    <section className="space-y-4">
      {!projectId && !readOnly && <ImpersonationAuditButton />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        {showHeading && (
          <div>
            <h2 className="font-semibold">
              {t(projectId ? 'projectParticipants' : 'people')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                projectId
                  ? readOnly
                    ? 'activeProjectParticipantsAreListedHereOnlyAdministratorsCanChangeThisList'
                    : 'onlyActiveParticipantsCanReceiveNewAssignmentsExistingAssignmentsArePreservedWh08699e16'
                  : 'createPeopleBeforeTheyConnectTheManualReferenceUniquelyIdentifiesEachPerson',
              )}
            </p>
          </div>
        )}
        {!projectId && mode === 'full' && (
          <Button
            className="cursor-pointer"
            onClick={() => {
              mutation.reset();
              setEditing(null);
              setForm({
                reference: '',
                firstName: '',
                lastName: '',
                email: '',
                phone: '',
                role: 'standard',
                active: true,
              });
              setLocalAccountDraft({ username: '', password: '' });
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('newPerson')}
          </Button>
        )}
      </div>
      {mode === 'full' && (
        <Input
          aria-label={t('searchPeople')}
          placeholder={t('searchPeople')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      {(people.isError || participants.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {t('unableToLoadPeople')}
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t(translationKey(mutation.error.message))}
        </p>
      )}
      {revokeSessions.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('unableToForceSignOut')}
        </p>
      )}
      {people.isPending && <p>{t('loading')}</p>}
      {people.data && !rows.length && (
        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          {t(
            mode === 'activeAdministrators'
              ? 'noActiveAdministratorFound'
              : projectId
                ? 'noPeopleFoundCreatePeopleInSettingsPeople'
                : 'noPeopleFound',
          )}
        </p>
      )}
      <div className="max-h-[65vh] overflow-auto">
        <table className="w-full text-left text-sm" aria-label={t('people')}>
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="border-b">
              <th scope="col" className="px-3 py-2">
                {t('people')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('email')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('actions')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((person) => {
              const member = participants.data?.participants.find(
                (p) => p.personId === person.id,
              );
              const account = localAccounts.data?.accounts.find(
                (item) => item.personId === person.id,
              );
              const connectedSince = account?.connectedSince
                ? new Intl.DateTimeFormat(
                    i18n.resolvedLanguage === 'fr' ? 'fr-FR' : 'en-US',
                    { dateStyle: 'short', timeStyle: 'short' },
                  ).format(account.connectedSince)
                : null;
              if (mode === 'activeAdministrators')
                return (
                  <tr key={person.id}>
                    <td colSpan={3}>
                      <button
                        type="button"
                        key={person.id}
                        className="flex w-full cursor-pointer items-center gap-3 rounded-lg border bg-background/60 p-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                        onClick={() => editPerson(person, account)}
                      >
                        <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {person.name}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {person.email || t('noEmail')}
                          </p>
                        </div>
                        {account?.oidcLinked && (
                          <Badge
                            variant="outline"
                            className="hidden sm:inline-flex"
                          >
                            {t('ssoIdentityLinked')}
                          </Badge>
                        )}
                        {account?.passwordConfigured && (
                          <Badge
                            variant="outline"
                            className="hidden sm:inline-flex"
                          >
                            {t('localLogin')}
                          </Badge>
                        )}
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </button>
                    </td>
                  </tr>
                );
              return (
                <tr key={person.id} className="align-top">
                  <td className="min-w-48 px-3 py-3">
                    <div className="break-words font-medium">
                      {person.name}{' '}
                      <span className="text-xs font-normal text-muted-foreground">
                        {person.reference}
                      </span>
                    </div>
                  </td>
                  <td className="min-w-48 px-3 py-3">
                    <p className="break-all text-xs text-muted-foreground">
                      {!projectId && <>{person.email || t('noEmail')} · </>}
                      {t(person.active ? 'active' : 'inactive')}
                      {!projectId && (
                        <>
                          {' '}
                          ·{' '}
                          {t(
                            person.role === 'administrator'
                              ? 'administrator'
                              : 'standardUser',
                          )}{' '}
                          · {person.phone} ·{' '}
                          {t(
                            person.identityLinked
                              ? 'loginLinked'
                              : 'loginNotLinked',
                          )}
                        </>
                      )}
                    </p>
                    {!projectId && account && (
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          aria-hidden="true"
                          className={`h-2 w-2 rounded-full ${
                            account.connected
                              ? 'bg-emerald-500'
                              : 'bg-muted-foreground/40'
                          }`}
                        />
                        {account.connected && connectedSince
                          ? t('connectedSinceDate', {
                              date: connectedSince,
                            })
                          : t('offline')}
                      </p>
                    )}
                    {member && (
                      <p className="text-xs text-muted-foreground">
                        {t('countAssignmentsIncludingOpenOpen', {
                          count: member.assignmentCount,
                          open: member.openAssignmentCount,
                        })}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {projectId && !readOnly ? (
                      <Button
                        size="sm"
                        variant={member ? 'outline' : 'default'}
                        className="cursor-pointer"
                        disabled={
                          mutation.isPending ||
                          participants.isPending ||
                          (!member && !person.active)
                        }
                        onClick={() =>
                          member
                            ? setRemoving({ person, member })
                            : mutation.mutate({
                                path: `/${projectId}/participants`,
                                method: 'POST',
                                body: { personId: person.id },
                              })
                        }
                      >
                        {!member && <UserPlus className="mr-1 h-3 w-3" />}
                        {t(member ? 'removeParticipant' : 'addParticipant')}
                      </Button>
                    ) : !projectId ? (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`${t('actions')} — ${person.name}`}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="end"
                          className="flex w-fit flex-col items-stretch gap-1"
                        >
                          {!readOnly && person.active && (
                            <TestAsPersonButton
                              personId={person.id}
                              name={person.name}
                            />
                          )}
                          {account?.connected && (
                            <Button
                              size="sm"
                              variant="destructive"
                              className="cursor-pointer"
                              disabled={revokeSessions.isPending}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    t(
                                      'forceSignOutNameAllActiveSessionsForThisPersonWillBeClosed',
                                      { name: person.name },
                                    ),
                                  )
                                )
                                  revokeSessions.mutate(person.id);
                              }}
                            >
                              <LogOut className="mr-1 h-3 w-3" />
                              {t('forceSignOut')}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className="cursor-pointer"
                            onClick={() => editPerson(person, account)}
                          >
                            <Pencil className="mr-1 h-3 w-3" />
                            {t('edit')}
                          </Button>
                        </PopoverContent>
                      </Popover>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Dialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) {
            setForm(null);
            setLocalAccountDraft(null);
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t(editing ? 'editPerson' : 'newPerson')}</DialogTitle>
            <DialogDescription>
              {t(
                'theAuthentikLoginUsesAStableIdentifierStandardUsersCanBeLinkedByEmailOnFirstCon7f7dfee1',
              )}
            </DialogDescription>
          </DialogHeader>
          {form && (
            <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                {t('manualReference')} *
                <Input
                  required
                  maxLength={80}
                  value={form.reference}
                  onChange={(e) =>
                    setForm({ ...form, reference: e.target.value })
                  }
                />
              </label>
              <label className="grid gap-1 text-sm">
                {t('firstName')} *
                <Input
                  required
                  maxLength={80}
                  autoComplete="given-name"
                  value={form.firstName}
                  onChange={(e) =>
                    setForm({ ...form, firstName: e.target.value })
                  }
                />
              </label>
              <label className="grid gap-1 text-sm">
                {t('lastName')} *
                <Input
                  required
                  maxLength={80}
                  autoComplete="family-name"
                  value={form.lastName}
                  onChange={(e) =>
                    setForm({ ...form, lastName: e.target.value })
                  }
                />
              </label>
              <label className="grid gap-1 text-sm">
                {t('fullName')}
                <Input
                  readOnly
                  value={`${form.firstName.trim()} ${form.lastName.trim()}`.trim()}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {t('email')} *
                <Input
                  required
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {t('phoneNumber')} *
                <Input
                  required
                  type="tel"
                  autoComplete="tel"
                  maxLength={40}
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {t('platformRole')} *
                <select
                  className="h-10 rounded-md border bg-background px-3"
                  value={form.role}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      role: e.target.value as 'standard' | 'administrator',
                    })
                  }
                >
                  <option value="standard">{t('standardUser')}</option>
                  <option value="administrator">{t('administrator')}</option>
                </select>
              </label>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                {t(
                  'standardUsersCanUseSimpleChatAndManualTasksServerSettingsAgentsAutomationsAndTe4c76bab1',
                )}
              </p>
              {form.role === 'administrator' &&
                !people.data?.people.find((person) => person.id === editing)
                  ?.identityLinked && (
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    {t(
                      'administratorLoginsMustBeExplicitlyLinkedUsingTheServerProvisioningToolEmailMatc52914d2',
                    )}
                  </p>
                )}
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) =>
                    setForm({ ...form, active: e.target.checked })
                  }
                />
                {t('activePerson')}
              </label>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                {t(
                  'inactivePeopleKeepTheirPreviousAssignmentsButCannotReceiveNewOnes',
                )}
              </p>
              {localAccountDraft &&
                (() => {
                  const account = editing
                    ? localAccounts.data?.accounts.find(
                        (item) => item.personId === editing,
                      )
                    : {
                        passwordConfigured: false,
                        oidcLinked: false,
                      };
                  if (!account && localAccounts.isPending) return null;
                  if (!account) return null;
                  return (
                    <div className="space-y-3 rounded-lg border p-4 sm:col-span-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h3 className="font-medium">
                            {t('localAccountAndPassword')}
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            {t(
                              account.oidcLinked
                                ? 'thisPersonIsLinkedToSsoALocalPasswordCannotBeConfigured'
                                : 'passwordsAreHashedWithArgon2idAndNeverStoredInTheConfigurationFile',
                            )}
                          </p>
                        </div>
                        <Badge
                          variant={account.oidcLinked ? 'default' : 'outline'}
                        >
                          {t(
                            account.oidcLinked
                              ? 'ssoIdentityLinked'
                              : 'ssoIdentityNotLinked',
                          )}
                        </Badge>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="grid gap-1 text-sm">
                          {t('username')}
                          <Input
                            value={localAccountDraft.username}
                            autoComplete="off"
                            disabled={account.oidcLinked}
                            required={Boolean(localAccountDraft.password)}
                            onChange={(event) =>
                              setLocalAccountDraft({
                                ...localAccountDraft,
                                username: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label className="grid gap-1 text-sm">
                          {t('password')}
                          <Input
                            type="password"
                            value={localAccountDraft.password}
                            autoComplete="new-password"
                            disabled={account.oidcLinked}
                            placeholder={
                              account.passwordConfigured
                                ? t('newPasswordLeaveEmptyToKeepIt')
                                : t('password12CharactersMinimum')
                            }
                            onChange={(event) =>
                              setLocalAccountDraft({
                                ...localAccountDraft,
                                password: event.target.value,
                              })
                            }
                          />
                        </label>
                      </div>
                    </div>
                  );
                })()}
              {mutation.isError && (
                <p
                  role="alert"
                  className="text-sm text-destructive sm:col-span-2"
                >
                  {t(translationKey(mutation.error.message))}
                </p>
              )}
              <DialogFooter className="sm:col-span-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() => setForm(null)}
                >
                  {t('cancel')}
                </Button>
                <Button type="submit" disabled={mutation.isPending}>
                  {t('save')}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('removeParticipant')}</DialogTitle>
            <DialogDescription>
              {removing && personLabel(removing.person)}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            {t(
              'existingAssignmentsWillBeKeptThisPersonWillNoLongerBeSelectableForNewWorkInThisProject',
            )}
          </p>
          {removing && (
            <p className="text-sm font-medium">
              {t('countAssignmentsIncludingOpenOpen', {
                count: removing.member.assignmentCount,
                open: removing.member.openAssignmentCount,
              })}
            </p>
          )}
          {mutation.isError && (
            <p role="alert" className="text-destructive">
              {t(translationKey(mutation.error.message))}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoving(null)}
              disabled={mutation.isPending}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() =>
                removing &&
                mutation.mutate({
                  path: `/${projectId}/participants/${removing.person.id}`,
                  method: 'DELETE',
                })
              }
            >
              {t('removeParticipant')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function ProjectParticipantsDialog({
  projectId,
  onClose,
}: {
  projectId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!projectId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('manageParticipants')}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {projectId && <PeopleManager projectId={projectId} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
