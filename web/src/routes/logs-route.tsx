import { LogsMonitor } from '@/components/logs/logs-monitor';
import { SessionDiagnostics } from '@/components/session-diagnostics';

export function LogsRoute() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b p-3">
        <SessionDiagnostics />
      </div>
      <div className="min-h-0 flex-1">
        <LogsMonitor />
      </div>
    </div>
  );
}
