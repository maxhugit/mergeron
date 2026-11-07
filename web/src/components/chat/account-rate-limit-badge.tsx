/** Header badge for ChatGPT rate-limit and credits snapshots. */
import { useEffect } from 'react';
import { CalendarDays, Gauge } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import {
  accountReadAccount,
  accountReadRateLimits,
} from '@/generated/api/sdk.gen';
import {
  accountReadAccountQueryKey,
  accountReadRateLimitsQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import { useAccountStore } from '@/stores/account-store';

function formatReset(value: number | null): string | null {
  if (!value) return null;
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return new Date(millis).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function periodLabel(windowDurationMins: number | null): string {
  if (windowDurationMins === 7 * 24 * 60) return 'Limite hebdomadaire';
  if ((windowDurationMins ?? 0) >= 28 * 24 * 60) return 'Limite mensuelle';
  return 'Limite longue durée';
}

export function AccountRateLimitBadge({
  showUnavailable = false,
  compact = false,
}: {
  showUnavailable?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { t: th } = useTranslation('headerControls');
  const setAccount = useAccountStore((s) => s.setAccount);
  const setRateLimits = useAccountStore((s) => s.setRateLimits);
  const storedAccount = useAccountStore((s) => s.account);
  const storedRateLimits = useAccountStore((s) => s.rateLimits);

  const accountQuery = useQuery({
    queryKey: accountReadAccountQueryKey(),
    queryFn: async () => {
      const { data } = await accountReadAccount({ throwOnError: true });
      return data;
    },
    staleTime: 30_000,
  });

  const activeAccount = accountQuery.data ?? storedAccount;
  const isChatGpt = activeAccount?.account?.type === 'chatgpt';

  const rateLimitsQuery = useQuery({
    queryKey: accountReadRateLimitsQueryKey(),
    queryFn: async () => {
      const { data } = await accountReadRateLimits({ throwOnError: true });
      return data;
    },
    enabled: isChatGpt,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (accountQuery.data) setAccount(accountQuery.data);
  }, [accountQuery.data, setAccount]);

  useEffect(() => {
    if (rateLimitsQuery.data) setRateLimits(rateLimitsQuery.data);
  }, [rateLimitsQuery.data, setRateLimits]);

  if (!isChatGpt)
    return showUnavailable ? (
      <p role="status" className="text-xs text-muted-foreground">
        {th(
          accountQuery.isPending
            ? 'quotaLoading'
            : accountQuery.isError
              ? 'quotaUnavailable'
              : 'quotaNotApplicable',
        )}
      </p>
    ) : null;

  const response = storedRateLimits ?? rateLimitsQuery.data;
  const snapshot = response?.rateLimits;
  const primary = snapshot?.primary;
  const secondary = snapshot?.secondary;
  const credits = snapshot?.credits;
  if (!primary && !secondary && !credits?.hasCredits && !credits?.unlimited)
    return showUnavailable ? (
      <p role="status" className="text-xs text-muted-foreground">
        {th(rateLimitsQuery.isPending ? 'quotaLoading' : 'quotaUnavailable')}
      </p>
    ) : null;

  const used = primary ? Math.round(primary.usedPercent) : null;
  const variant = used !== null && used >= 90 ? 'destructive' : 'secondary';
  const creditLabel = credits
    ? credits.unlimited
      ? t('unlimited')
      : credits.hasCredits
        ? (credits.balance ?? t('credits66c22fad'))
        : null
    : null;
  const primaryReset = formatReset(primary?.resetsAt ?? null);
  const secondaryReset = formatReset(secondary?.resetsAt ?? null);
  const secondaryLabel = periodLabel(secondary?.windowDurationMins ?? null);
  const primaryTitle = primaryReset
    ? `Limite du compte · réinitialisation : ${primaryReset}`
    : t('accountRateLimits');
  const secondaryTitle = secondaryReset
    ? `${secondaryLabel} · réinitialisation : ${secondaryReset}`
    : secondaryLabel;

  return (
    <div className="flex items-center gap-1">
      <Badge variant={variant} className="text-xs" title={primaryTitle}>
        <Gauge className="h-3 w-3" />
        {used !== null && <span>{used}%</span>}
        {creditLabel && !compact && (
          <span className="hidden sm:inline text-muted-foreground">
            {used !== null ? '· ' : ''}
            {creditLabel}
          </span>
        )}
      </Badge>
      {secondary && (
        <Badge
          variant={secondary.usedPercent >= 90 ? 'destructive' : 'secondary'}
          className="text-xs"
          title={secondaryTitle}
        >
          <CalendarDays className="h-3 w-3" />
          <span>{Math.round(secondary.usedPercent)}%</span>
        </Badge>
      )}
    </div>
  );
}
