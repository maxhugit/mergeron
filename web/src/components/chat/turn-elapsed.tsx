import { elapsedMilliseconds } from '@/lib/turn-elapsed';
import { useEffect, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TimelineEntry } from '@/types/timeline';

type Turn = Extract<TimelineEntry, { kind: 'turn' }>;
export function TurnElapsed({
  entry,
  running,
}: {
  entry: Turn;
  running: boolean;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsed = elapsedMilliseconds(entry, running, now);
  if (elapsed == null) return null;
  const seconds = Math.floor(elapsed / 1000);
  const duration = `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
  const label = running
    ? t('inProgress')
    : entry.status === 'failed'
      ? t('agentElapsedFailed')
      : entry.status === 'interrupted'
        ? t('agentElapsedInterrupted')
        : t('transferStatusSuccess');
  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      data-turn-elapsed
    >
      <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
      <span>
        {label} · {duration}
      </span>
    </div>
  );
}
