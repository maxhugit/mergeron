import { CheckCircle2, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { CodexRecoveryPhase } from '@/types/timeline';

export function CodexRecoveryNotice({
  phase,
  message,
}: {
  phase: CodexRecoveryPhase;
  message: string;
}) {
  const waiting = phase === 'restarting';
  const success = phase === 'ready' || phase === 'resumed';
  const Icon = waiting ? LoaderCircle : success ? CheckCircle2 : TriangleAlert;
  return (
    <div
      className="text-center"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={waiting}
    >
      <span
        className={`inline-flex max-w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${success ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : waiting ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300' : 'bg-destructive/10 text-destructive'}`}
      >
        <Icon
          aria-hidden="true"
          className={`size-5 shrink-0 ${waiting ? 'animate-spin motion-reduce:animate-none' : ''}`}
        />
        <span>{message}</span>
      </span>
    </div>
  );
}
