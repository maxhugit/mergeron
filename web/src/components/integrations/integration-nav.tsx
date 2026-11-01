import { useId } from 'react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/** Compact, keyboard-accessible navigation shared by integration inventories. */
export function IntegrationNav<T extends string>({
  label,
  value,
  onChange,
  items,
  secondary = false,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: readonly { value: T; label: string; description?: string }[];
  secondary?: boolean;
}) {
  const id = useId();
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        'flex shrink-0 flex-wrap gap-x-5 border-b',
        secondary
          ? 'mb-3 border-border/50'
          : '-mx-4 mb-4 rounded-t-lg bg-muted/30 px-4',
      )}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
          return;
        const tabs = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[role="tab"]',
          ),
        ];
        const current = tabs.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : (current +
                  (event.key === 'ArrowRight' ? 1 : -1) +
                  tabs.length) %
                tabs.length;
        event.preventDefault();
        tabs[next]?.focus();
        tabs[next]?.click();
      }}
    >
      {items.map((item) => {
        const button = (
          <button
            type="button"
            role="tab"
            id={`${id}-${item.value}`}
            aria-selected={item.value === value}
            tabIndex={item.value === value ? 0 : -1}
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex min-h-9 items-center gap-1.5 border-b-2 py-2 text-xs focus-visible:outline-2 focus-visible:outline-ring',
              item.value === value
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground',
              secondary && 'border-b-0',
            )}
          >
            {secondary && (
              <span
                aria-hidden="true"
                className={cn(
                  'size-1 rounded-full',
                  item.value === value ? 'bg-primary' : 'bg-transparent',
                )}
              />
            )}
            {item.label}
          </button>
        );
        return item.description ? (
          <Tooltip key={item.value}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="bottom">{item.description}</TooltipContent>
          </Tooltip>
        ) : (
          <span key={item.value} className="contents">
            {button}
          </span>
        );
      })}
    </div>
  );
}
