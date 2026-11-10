import type { TimelineEntry } from '@/types/timeline';
type Turn = Extract<TimelineEntry, { kind: 'turn' }>;
export function elapsedMilliseconds(
  entry: Turn,
  running: boolean,
  now: number,
) {
  if (!running && entry.durationMs != null)
    return Math.max(0, entry.durationMs);
  if (entry.startedAt == null) return null;
  const end = running
    ? now
    : entry.completedAt == null
      ? null
      : entry.completedAt * 1000;
  return end == null ? null : Math.max(0, end - entry.startedAt * 1000);
}
