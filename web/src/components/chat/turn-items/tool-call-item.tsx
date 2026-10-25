/**
 * Renders a single MCP tool call with a collapsible body.
 * Header shows tool name + status; body (args, progress, result) can be toggled.
 */
import { useEffect, useRef, useState } from 'react';
import { useExpandedTechnicalDetails } from '@/lib/technical-display';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnItem } from '@/types/timeline';
import { cn } from '@/lib/utils';

interface Props {
  item: Extract<TurnItem, { type: 'mcpToolCall' }>;
}

export function ToolCallItem({ item }: Props) {
  const { t } = useTranslation();
  const expandDetails = useExpandedTechnicalDetails();
  const [requestedOpen, setOpen] = useState(expandDetails || !item.completed);
  const open = requestedOpen || item.failed === true;
  const hasBody = !!(item.toolArgs || item.toolProgress || item.content);

  // Auto-collapse once the tool call finishes
  const prevCompleted = useRef(item.completed);
  useEffect(() => {
    if (
      item.completed &&
      !prevCompleted.current &&
      !expandDetails &&
      !item.failed
    ) {
      setOpen(false);
    }
    prevCompleted.current = item.completed;
  }, [item.completed, expandDetails, item.failed]);

  const headerClasses = cn(
    'flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground transition-colors',
    hasBody && 'cursor-pointer hover:bg-muted/50',
  );

  const headerContent = (
    <>
      {hasBody && (
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
      )}
      <span className="font-medium">
        {item.toolServer}/{item.toolName}
      </span>
      {!item.completed && <Loader2 className="h-3 w-3 animate-spin" />}
      {item.completed && (
        <span className={item.failed ? 'text-red-500' : 'text-green-500'}>
          {t(item.failed ? 'failed' : 'donee5fd9cfe')}
        </span>
      )}
    </>
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/30">
      {hasBody ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={headerClasses}
        >
          {headerContent}
        </button>
      ) : (
        <div className={headerClasses}>{headerContent}</div>
      )}

      {open && (
        <>
          {item.toolArgs && (
            <pre className="m-0 border-t border-border/30 bg-muted/20 px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
              {item.toolArgs}
            </pre>
          )}
          {item.toolProgress && !item.completed && (
            <div className="border-t border-border/30 px-3 py-1.5 text-xs text-muted-foreground">
              {item.toolProgress}
            </div>
          )}
          {item.content && (
            <pre className="m-0 max-h-40 overflow-auto border-t border-border/30 px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
              {item.content}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
