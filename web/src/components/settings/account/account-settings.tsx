/** Settings tab for Codex account/provider auth state and login flows. */
import { useEffect, useState } from 'react';
import { KeyRound, Loader2, LogOut, RefreshCw, UserRound } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  accountReadAccount,
  accountLogout,
  accountReadRateLimits,
} from '@/generated/api/sdk.gen';
import {
  accountReadAccountQueryKey,
  accountReadRateLimitsQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import type { AccountReadResponseDto } from '@/generated/api/types.gen';
import { showSnackbar } from '@/stores/snackbar-store';
import { useAccountStore } from '@/stores/account-store';
import { AccountLoginDialog } from './account-login-dialog';
import { RateLimitsCard, InfoRow } from './rate-limits-card';

export function AccountSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const setAccount = useAccountStore((s) => s.setAccount);
  const setRateLimits = useAccountStore((s) => s.setRateLimits);
  const storedAccount = useAccountStore((s) => s.account);
  const storedRateLimits = useAccountStore((s) => s.rateLimits);
  const [loginOpen, setLoginOpen] = useState(false);

  const accountQuery = useQuery({
    queryKey: accountReadAccountQueryKey(),
    queryFn: async () => {
      const { data } = await accountReadAccount({ throwOnError: true });
      // Only a fresh server read may restore authentication after logout.
      setAccount(data);
      return data;
    },
    refetchOnWindowFocus: true,
  });

  const account = accountQuery.data ?? storedAccount;
  const isChatGpt = account?.account?.type === 'chatgpt';
  const canLogout = Boolean(account?.account);

  const rateLimitsQuery = useQuery({
    queryKey: accountReadRateLimitsQueryKey(),
    queryFn: async () => {
      const { data } = await accountReadRateLimits({ throwOnError: true });
      return data;
    },
    enabled: isChatGpt,
    retry: false,
  });

  useEffect(() => {
    if (rateLimitsQuery.data) setRateLimits(rateLimitsQuery.data);
  }, [rateLimitsQuery.data, setRateLimits]);

  const invalidateAccount = () => {
    void queryClient.invalidateQueries({
      queryKey: accountReadAccountQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: accountReadRateLimitsQueryKey(),
    });
  };

  const logoutMutation = useMutation({
    mutationFn: () => accountLogout({ throwOnError: true }),
    onSuccess: () => {
      setAccount(null);
      setRateLimits(null);
      invalidateAccount();
      showSnackbar(t('codexAccountLoggedOut'), 'success');
    },
  });

  return (
    <section className="space-y-4">
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={accountQuery.isFetching}
          onClick={() => accountQuery.refetch()}
        >
          {accountQuery.isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('refresh')}
        </Button>
      </div>

      {accountQuery.isLoading && !account && (
        <div className="rounded-lg border border-border bg-card/50 px-4 py-3 text-sm text-muted-foreground">
          {t('loadingb04ba49f')}
        </div>
      )}

      {account && <AccountSummary account={account} />}

      {isChatGpt && (
        <RateLimitsCard
          snapshot={
            storedRateLimits?.rateLimits ??
            rateLimitsQuery.data?.rateLimits ??
            null
          }
          isLoading={rateLimitsQuery.isLoading}
          isError={rateLimitsQuery.isError}
        />
      )}

      {!isChatGpt && (
        <div className="rounded-lg border border-border bg-card/50 px-4 py-3 text-xs text-muted-foreground">
          {t('rateLimitsAreNotShownForApiKeyOrCustomProviderProxyMode')}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="h-8" onClick={() => setLoginOpen(true)}>
          <KeyRound className="h-3.5 w-3.5" />
          {isChatGpt ? t('switchAccount') : t('loginWithChatGptOrApiKey')}
        </Button>
        {canLogout && (
          <Button
            size="sm"
            variant="destructive"
            className="h-8"
            disabled={logoutMutation.isPending}
            onClick={() => logoutMutation.mutate()}
          >
            {logoutMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogOut className="h-3.5 w-3.5" />
            )}
            {t('logoutCodexAccount')}
          </Button>
        )}
      </div>

      {loginOpen && (
        <AccountLoginDialog
          open={loginOpen}
          onOpenChange={setLoginOpen}
          onChanged={invalidateAccount}
        />
      )}
    </section>
  );
}

/** Displays current account type, provider metadata, and ChatGPT identity. */
function AccountSummary({ account }: { account: AccountReadResponseDto }) {
  const { t } = useTranslation();
  const provider = account.provider;
  const isChatGpt = account.account?.type === 'chatgpt';
  const isApiKeyMode =
    account.account?.type === 'apiKey' ||
    (!account.account && Boolean(provider.id));

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card/50 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {isChatGpt ? (
          <UserRound className="h-4 w-4" />
        ) : (
          <KeyRound className="h-4 w-4" />
        )}
        <span className="text-sm font-medium">
          {isChatGpt
            ? t('chatGptMode')
            : isApiKeyMode
              ? t('apiKeyMode')
              : t('notLoggedIn')}
        </span>
        <Badge variant={isChatGpt ? 'default' : 'secondary'}>
          {isChatGpt ? t('chatGpt') : t('provider')}
        </Badge>
      </div>

      {account.account?.type === 'chatgpt' && (
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <InfoRow label={t('email')} value={account.account.email ?? ''} />
          <InfoRow
            label={t('plan')}
            value={account.account.planType ?? t('unknown50d8b4a9')}
          />
        </div>
      )}

      <Separator />

      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <InfoRow
          label={t('provider')}
          value={provider.name ?? provider.id ?? t('unknown50d8b4a9')}
        />
        <InfoRow
          label={t('baseUrl')}
          value={provider.baseUrlMasked ?? t('notConfigured')}
        />
        <InfoRow
          label={t('envKey')}
          value={provider.envKey ?? t('notConfigured')}
        />
        <InfoRow
          label={t('credential')}
          value={
            provider.envPresent === true
              ? t('present')
              : provider.envPresent === false
                ? t('missing')
                : t('unknown50d8b4a9')
          }
        />
      </div>
    </div>
  );
}
