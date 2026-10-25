import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Layers3,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { readLogs, readLogStorage, type LogEntry } from '@/lib/logs-api';
import { LogRetentionDialog } from './log-retention-dialog';
import { logSizeLabel } from '@/lib/log-storage-size';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 100;
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

export function LogsMonitor() {
  const { t, i18n } = useTranslation(['logs', 'common']);
  const [offset, setOffset] = useState(0);
  const [levels, setLevels] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [live, setLive] = useState(true);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const storage = useQuery({
    queryKey: ['log-storage'],
    queryFn: readLogStorage,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const query = useQuery({
    queryKey: ['logs-monitor', offset, levels, sources],
    queryFn: () => readLogs({ offset, limit: PAGE_SIZE, levels, sources }),
    refetchInterval: live ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  const availableSources = query.data?.availableSources ?? [];
  const availableLevels = query.data?.availableLevels ?? LEVELS;
  const visibleEntries = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase(i18n.language);
    if (!needle) return query.data?.data ?? [];
    return (query.data?.data ?? []).filter((entry) =>
      `${entry.source} ${entry.message} ${JSON.stringify(entry.fields)}`
        .toLocaleLowerCase(i18n.language)
        .includes(needle),
    );
  }, [i18n.language, query.data?.data, search]);
  const total = query.data?.total ?? 0;
  const start = total ? offset + 1 : 0;
  const end = Math.min(offset + PAGE_SIZE, total);
  const merged = sources.length !== 1;
  const selectedSourcesLabel =
    sources.length === 0 ? t('allSources') : sources.join(', ');

  const toggle = (
    value: string,
    selected: string[],
    setSelected: (next: string[]) => void,
  ) => {
    setOffset(0);
    setSelected(
      selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value],
    );
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      {retentionOpen && storage.data && (
        <LogRetentionDialog
          storage={storage.data}
          onClose={() => setRetentionOpen(false)}
        />
      )}
      <div className="shrink-0 space-y-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto">
            <div className="flex items-center gap-2">
              <h1 className="font-semibold">{t('logs')}</h1>
              <Badge variant="secondary" className="gap-1 font-normal">
                <Layers3 className="h-3 w-3" />
                {merged ? t('mergedView') : sources[0]}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('monitorMergeAndFilterApplicationLogsInRealTime')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!storage.data}
            onClick={() => setRetentionOpen(true)}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t('logRetentionSettings')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={() => setLive((value) => !value)}
          >
            {live ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {live ? t('pauseLiveUpdates') : t('resumeLiveUpdates')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', query.isFetching && 'animate-spin')}
            />
            {t('refresh')}
          </Button>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(14rem,1fr)_minmax(0,3fr)]">
          <label className="relative block">
            <span className="sr-only">{t('searchLogs')}</span>
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('searchInDisplayedLogs')}
              className="pl-9"
            />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-muted-foreground">
              {t('levels')}
            </span>
            <FilterButton
              active={levels.length === 0}
              label={t('all')}
              onClick={() => {
                setOffset(0);
                setLevels([]);
              }}
            />
            {availableLevels.map((level) => (
              <FilterButton
                key={level}
                active={levels.includes(level)}
                label={level}
                tone={level}
                onClick={() => toggle(level, levels, setLevels)}
              />
            ))}
            <span
              className="ml-auto text-xs text-muted-foreground"
              title={t('logStorageEstimateHelp')}
            >
              {storage.data
                ? t('logStorageEstimate', {
                    size: logSizeLabel(storage.data.estimatedBytes),
                  })
                : t('logStorageUnavailable')}
            </span>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs font-medium text-muted-foreground">
            {t('sources')}
          </span>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t('filterLogSources')}
                title={selectedSourcesLabel}
                className="flex h-9 min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm shadow-xs outline-none transition-[color,box-shadow] hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="truncate">{selectedSourcesLabel}</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-[min(28rem,calc(100vw-2rem))] p-1"
            >
              <SourceOption
                checked={sources.length === 0}
                label={t('allSources')}
                onChange={() => {
                  setOffset(0);
                  setSources([]);
                }}
              />
              <div className="my-1 border-t" />
              <div className="max-h-72 overflow-y-auto">
                {availableSources.map((source) => (
                  <SourceOption
                    key={source}
                    checked={sources.includes(source)}
                    label={source}
                    onChange={() => toggle(source, sources, setSources)}
                  />
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        {query.isError ? (
          <p role="alert" className="p-6 text-sm text-destructive">
            {t('unableToLoadLogs')}: {query.error.message}
          </p>
        ) : !query.isPending && visibleEntries.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {t('noLogMatchesTheSelectedFilters')}
          </p>
        ) : (
          <div className="divide-y">
            {visibleEntries.map((entry, index) => (
              <LogRow
                key={`${entry.timestamp}:${entry.source}:${index}`}
                entry={entry}
                locale={i18n.language}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
        <span>
          {start}-{end} / {total}
          {search && ` · ${visibleEntries.length} ${t('displayed')}`}
        </span>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('previous')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer"
            disabled={!query.data?.hasMore}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            {t('next')}
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function SourceOption({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
      />
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </label>
  );
}

function FilterButton({
  active,
  label,
  tone,
  onClick,
}: {
  active: boolean;
  label: string;
  tone?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 max-w-56 cursor-pointer items-center gap-1 truncate rounded-full border px-2.5 text-xs transition-colors hover:bg-accent',
        active &&
          'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
        !active &&
          tone === 'warn' &&
          'border-amber-300 text-amber-700 dark:text-amber-300',
        !active &&
          ['error', 'fatal'].includes(tone ?? '') &&
          'border-red-300 text-red-700 dark:text-red-300',
      )}
      title={label}
      onClick={onClick}
    >
      {active && <Check className="h-3 w-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </button>
  );
}

function LogRow({ entry, locale }: { entry: LogEntry; locale: string }) {
  const { t } = useTranslation();
  return (
    <article className="grid gap-2 px-4 py-3 hover:bg-muted/30 md:grid-cols-[10rem_7rem_minmax(0,1fr)]">
      <time className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
        {new Intl.DateTimeFormat(locale, {
          dateStyle: 'short',
          timeStyle: 'medium',
        }).format(new Date(entry.timestamp))}
      </time>
      <div className="flex min-w-0 items-start gap-1.5">
        <LevelBadge level={entry.level} />
        <span
          className="truncate text-xs text-muted-foreground"
          title={entry.source}
        >
          {entry.source}
        </span>
      </div>
      <div className="min-w-0">
        <p className="break-words text-sm">{entry.message || t('noMessage')}</p>
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer select-none hover:text-foreground">
            {t('details')}
          </summary>
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-[11px]">
            {JSON.stringify(entry.fields, null, 2)}
          </pre>
        </details>
      </div>
    </article>
  );
}

function LevelBadge({ level }: { level: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase',
        level === 'info' &&
          'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
        level === 'warn' &&
          'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
        ['error', 'fatal'].includes(level) &&
          'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
        ['trace', 'debug', 'unknown'].includes(level) &&
          'bg-muted text-muted-foreground',
      )}
    >
      {level}
    </span>
  );
}
