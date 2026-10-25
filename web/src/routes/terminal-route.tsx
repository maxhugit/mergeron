/** Global multi-terminal route component. */
import { TerminalWorkspace } from '@/components/terminal/terminal-workspace';

export function TerminalRoute() {
  return (
    <div className="min-h-0 flex-1">
      <TerminalWorkspace contextKey="global" />
    </div>
  );
}
