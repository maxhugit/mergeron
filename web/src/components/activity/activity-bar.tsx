import {
  Activity,
  Bot,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  RefreshCw,
  Workflow,
} from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { useActivity } from './activity-state';

export function ActivityButton() {
  const state = useActivity();
  const breakpoint = useBreakpoint();
  const { t } = useTranslation();
  if (!state || breakpoint === 'desktop') return null;
  const waiting = !state.data?.agents.stale
    ? state.data?.agents.waiting
    : undefined;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative size-9 shrink-0"
      aria-label={t('activityTitle')}
      aria-haspopup="dialog"
      aria-expanded={state.open}
      onClick={(event) => state.show(event.currentTarget)}
    >
      <Activity className="size-4" />
      {!!waiting && (
        <span
          className="absolute -right-1 -top-1 min-w-4 rounded-full bg-amber-500 px-1 text-[10px] text-black"
          aria-label={t('activityWaiting', { count: waiting })}
        >
          {waiting > 99 ? '99+' : waiting}
        </span>
      )}
    </Button>
  );
}
function ActivityDetails() {
  const state = useActivity()!;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const breakpoint = useBreakpoint();
  const data = state.data;
  const jump = (threadId: string) => {
    state.setOpen(false);
    void navigate({ to: '/t/$threadId', params: { threadId } });
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm">
          <ConnectionIcon />
          {t(
            state.connection === 'connected'
              ? 'activityConnectionConnected'
              : state.connection === 'offline'
                ? 'offline'
                : 'activityConnectionReconnecting',
          )}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('activityRefresh')}
          onClick={state.refresh}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {!data ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(state.unavailable ? 'activityUnavailable' : 'loading')}
        </p>
      ) : (
        <>
          <section aria-label={t('activityAgents')} className="space-y-2">
            <h3 className="text-sm font-medium">{t('activityAgents')}</h3>
            {data.agents.stale && (
              <p role="status" className="text-xs text-amber-600">
                {t('activityStale')}
              </p>
            )}
            {!data.agents.total && !data.agents.stale && (
              <p className="text-xs text-muted-foreground">
                {t('activityNoAgents')}
              </p>
            )}
            {data.agents.items.map((agent) => (
              <Button
                key={agent.threadId}
                variant="ghost"
                className="h-auto min-h-11 w-full justify-start gap-2 whitespace-normal py-2 text-left"
                onClick={() => jump(agent.threadId)}
              >
                {agent.state === 'waiting' ? (
                  <CircleAlert className="size-4 shrink-0 text-amber-500" />
                ) : (
                  <Bot className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t(
                    agent.state === 'waiting'
                      ? 'activityStateWaiting'
                      : 'running',
                  )}
                </span>
              </Button>
            ))}
            {data.agents.total > data.agents.items.length && (
              <p className="text-xs text-muted-foreground">
                {t('activityLimited', { count: data.agents.total })}
              </p>
            )}
          </section>
          <section
            aria-label={t('activityOperations')}
            className="space-y-2 border-t pt-3"
          >
            <h3 className="text-sm font-medium">
              {t('activityOperations')} · {data.operations.total}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t('activityOperationsHint')}
            </p>
            {data.operations.items.map((operation) => (
              <div
                key={operation.kind + operation.id}
                className="flex items-center gap-2 text-sm"
              >
                <Workflow className="size-4 shrink-0" />
                {operation.threadId ? (
                  <Button
                    variant="ghost"
                    className="h-auto min-h-11 min-w-0 flex-1 justify-start whitespace-normal py-2 text-left"
                    onClick={() => jump(operation.threadId!)}
                  >
                    {t(
                      operation.kind === 'media'
                        ? 'activityOperationMedia'
                        : 'activityOperationPreview',
                    )}
                  </Button>
                ) : (
                  <span>
                    {t(
                      operation.kind === 'media'
                        ? 'activityOperationMedia'
                        : 'activityOperationPreview',
                    )}
                  </span>
                )}
              </div>
            ))}
            {data.operations.total > data.operations.items.length && (
              <p className="text-xs text-muted-foreground">
                {t('activityLimited', { count: data.operations.total })}
              </p>
            )}
          </section>
          <p className="border-t pt-3 text-xs text-muted-foreground">
            {t(
              data.installation.environment === 'production'
                ? 'activityEnvironmentProduction'
                : data.installation.environment === 'development'
                  ? 'activityEnvironmentDevelopment'
                  : 'activityEnvironmentUnknown',
            )}{' '}
            · {data.installation.version ?? t('activityUnknownVersion')} ·{' '}
            {data.installation.channel}
          </p>
        </>
      )}
      {breakpoint === 'tablet' && (
        <label className="flex min-h-11 items-center gap-2 border-t pt-2 text-sm">
          <input
            type="checkbox"
            checked={state.tabletBar}
            onChange={(event) => state.setTabletBar(event.target.checked)}
          />
          {t('activityTabletBar')}
        </label>
      )}
      {state.preferenceError && (
        <p role="alert" className="text-xs text-destructive">
          {t('activityPreferenceError')}
        </p>
      )}
    </div>
  );
}
function ConnectionIcon() {
  const state = useActivity()!;
  return state.connection === 'connected' ? (
    <CircleCheck
      aria-hidden="true"
      className="size-3.5 shrink-0 text-emerald-500"
    />
  ) : state.connection === 'offline' ? (
    <CircleAlert
      aria-hidden="true"
      className="size-3.5 shrink-0 text-destructive"
    />
  ) : (
    <LoaderCircle
      aria-hidden="true"
      className="size-3.5 shrink-0 animate-spin text-amber-500"
    />
  );
}
export function ActivityBar() {
  const state = useActivity();
  const breakpoint = useBreakpoint();
  const { t } = useTranslation();
  if (!state) return null;
  const data = state.data;
  const countsKnown = data && !data.agents.stale;
  const bar =
    breakpoint === 'desktop' || (breakpoint === 'tablet' && state.tabletBar);
  const summary = (
    <>
      <span className="flex shrink-0 items-center gap-1.5">
        <ConnectionIcon />
        <span className="hidden lg:inline">
          {t(
            state.connection === 'connected'
              ? 'activityConnectionConnected'
              : state.connection === 'offline'
                ? 'offline'
                : 'activityConnectionReconnecting',
          )}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <Bot className="size-3.5 shrink-0" />
        <span className="truncate">
          {countsKnown
            ? t('activityRunning', { count: data.agents.running })
            : t(
                state.unavailable
                  ? 'activityUnavailable'
                  : data
                    ? 'activityStaleShort'
                    : 'loading',
              )}
        </span>
      </span>
      {countsKnown && data.agents.waiting > 0 && (
        <span className="flex shrink-0 items-center gap-1 text-amber-600">
          <CircleAlert className="size-3.5" />
          {t('activityWaiting', { count: data.agents.waiting })}
        </span>
      )}
      <span className="flex-1" />
      {data && (
        <>
          <span className="hidden items-center gap-1.5 md:flex">
            <Workflow className="size-3.5" />
            {t('activityOperationCount', { count: data.operations.total })}
          </span>
          <span className="shrink-0">
            {t(
              data.installation.environment === 'production'
                ? 'activityEnvironmentProduction'
                : data.installation.environment === 'development'
                  ? 'activityEnvironmentDevelopment'
                  : 'activityEnvironmentUnknown',
            )}{' '}
            · {data.installation.version ?? '—'}
          </span>
        </>
      )}
    </>
  );
  if (breakpoint !== 'desktop')
    return (
      <>
        {bar && (
          <footer
            aria-label={t('activityTitle')}
            data-testid="platform-activity-bar"
            className="h-8 shrink-0 border-t bg-muted/40"
          >
            <button
              type="button"
              onClick={(event) => state.show(event.currentTarget)}
              className="flex h-full w-full items-center gap-3 px-3 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={t('activityTitle')}
              aria-haspopup="dialog"
            >
              {summary}
            </button>
          </footer>
        )}
        <Sheet open={state.open} onOpenChange={state.setOpen}>
          <SheetContent
            side="bottom"
            style={{ backgroundColor: 'var(--popover)' }}
            className="max-h-[80dvh] rounded-t-xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              state.restoreFocus();
            }}
          >
            <SheetTitle>{t('activityTitle')}</SheetTitle>
            <SheetDescription className="sr-only">
              {t('activityDescription')}
            </SheetDescription>
            <div className="min-h-0 overflow-y-auto overscroll-contain">
              <ActivityDetails />
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  return (
    <Popover open={state.open} onOpenChange={state.setOpen}>
      <footer
        aria-label={t('activityTitle')}
        data-testid="platform-activity-bar"
        className="h-7 shrink-0 border-t bg-muted/40"
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-full w-full items-center gap-4 px-3 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={t('activityTitle')}
          >
            {summary}
          </button>
        </PopoverTrigger>
      </footer>
      <PopoverContent
        side="top"
        style={{ backgroundColor: 'var(--popover)' }}
        align="end"
        role="dialog"
        aria-label={t('activityTitle')}
        className="max-h-[min(70dvh,640px)] w-[400px] max-w-[calc(100vw-1rem)] overflow-y-auto bg-popover p-4"
      >
        <h2 className="mb-3 font-medium">{t('activityTitle')}</h2>
        <ActivityDetails />
      </PopoverContent>
    </Popover>
  );
}
