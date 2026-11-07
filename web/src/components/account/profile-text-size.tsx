/** A profile preference per viewport class, never a device fingerprint. */
import { useLayoutEffect } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useBreakpoint, type Breakpoint } from '@/hooks/use-breakpoint';
import { Button } from '@/components/ui/button';
import {
  platformSessionKey,
  updateAuthResource,
  usePlatformSession,
  type PlatformSession,
} from '@/lib/platform-session';

export type TextSizes = Record<Breakpoint, number>;
function profileTextSize(
  sizes: PlatformSession['textSizes'],
  support: Breakpoint,
) {
  const value = sizes?.[support];
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 80 &&
    value <= 150 &&
    value % 10 === 0
    ? value
    : 100;
}
export function ProfileTextSizeApplier({
  sizes,
}: {
  sizes: PlatformSession['textSizes'];
}) {
  const support = useBreakpoint();
  const percent = profileTextSize(sizes, support);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.style.fontSize;
    root.style.fontSize = `${percent}%`;
    return () => {
      root.style.fontSize = previous;
    };
  }, [percent]);
  return null;
}
export function ProfileTextSize({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation('headerControls');
  const support = useBreakpoint();
  const session = usePlatformSession();
  const client = useQueryClient();
  const percent = profileTextSize(session.data?.textSizes, support);
  const owner = session.data?.personId;
  const save = useMutation({
    mutationFn: ({
      percent: next,
      support: targetSupport,
    }: {
      percent: number;
      owner: string;
      support: Breakpoint;
    }) =>
      updateAuthResource<{ textSizes: TextSizes }>('preferences', {
        textSize: { support: targetSupport, percent: next },
      }),
    onSuccess: (result, variables) => {
      client.setQueryData<PlatformSession>(platformSessionKey, (current) =>
        current?.personId === variables.owner
          ? { ...current, textSizes: result.textSizes }
          : current,
      );
    },
  });
  const disabled =
    !owner ||
    session.data?.kind !== 'person' ||
    !session.data.active ||
    Boolean(session.data.impersonation) ||
    save.isPending;
  const change = (next: number) => {
    if (!disabled && owner) save.mutate({ percent: next, owner, support });
  };
  return (
    <section
      className="space-y-2 border-t pt-3"
      aria-label={t('textSize')}
      aria-busy={save.isPending}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          {t('textSize')}{' '}
          {!compact && (
            <span className="text-xs text-muted-foreground">
              ·{' '}
              {support === 'mobile'
                ? t('mobile')
                : support === 'tablet'
                  ? t('tablet')
                  : t('desktop')}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="outline"
            className="size-9"
            aria-label={t('smaller')}
            disabled={disabled || percent <= 80}
            onClick={() => change(percent - 10)}
          >
            <Minus className="size-4" />
          </Button>
          {compact ? (
            <Button
              variant="ghost"
              className="min-w-12 px-1 tabular-nums"
              aria-label={t('reset')}
              disabled={disabled || percent === 100}
              onClick={() => change(100)}
            >
              {percent}%
            </Button>
          ) : (
            <output
              className="min-w-12 text-center tabular-nums"
              aria-live="polite"
            >
              {percent}%
            </output>
          )}
          <Button
            size="icon"
            variant="outline"
            className="size-9"
            aria-label={t('larger')}
            disabled={disabled || percent >= 150}
            onClick={() => change(percent + 10)}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </div>
      {!compact && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{t('savedForSupport')}</span>
          <button
            type="button"
            disabled={disabled || percent === 100}
            onClick={() => change(100)}
            className="shrink-0 underline disabled:opacity-50"
          >
            {t('reset')}
          </button>
        </div>
      )}
      {save.isError && (
        <p role="alert" className="text-xs text-destructive">
          {t('saveError')}
        </p>
      )}
    </section>
  );
}
