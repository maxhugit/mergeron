import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronDown, PanelRightOpen } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

/** Shared mouse, touch and keyboard behavior for both association pills. */
export function AgentLinkPreview({
  kind,
  label,
  sidebarLabel,
  open,
  onOpenChange,
  onSidebar,
  trigger,
  children,
}: {
  kind: 'deliverable' | 'task';
  label: string;
  sidebarLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSidebar: () => void;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => {
    if (!open) {
      pinned.current = false;
      clearTimeout(timer.current);
    }
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const leave = () => {
    cancel();
    if (!pinned.current)
      timer.current = setTimeout(() => {
        if (!pinned.current) onOpenChange(false);
      }, 180);
  };
  const blue = kind === 'deliverable';
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (!value) pinned.current = false;
        onOpenChange(value);
      }}
    >
      <div
        role="group"
        aria-label={label}
        className={`inline-flex min-w-0 flex-1 items-stretch overflow-hidden rounded-md border ${blue ? 'border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300'}`}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            title={label}
            className="inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2 py-1 text-left"
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') {
                cancel();
                onOpenChange(true);
              }
            }}
            onPointerLeave={leave}
            onClick={(event) => {
              event.preventDefault();
              cancel();
              if (open && !pinned.current) pinned.current = true;
              else {
                pinned.current = !open;
                onOpenChange(!open);
              }
            }}
          >
            {trigger}
            <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <button
          type="button"
          aria-label={sidebarLabel}
          title={sidebarLabel}
          className={`shrink-0 cursor-pointer border-l px-2 ${blue ? 'border-blue-500/20 hover:bg-blue-500/10' : 'border-violet-500/20 hover:bg-violet-500/10'}`}
          onClick={() => {
            cancel();
            pinned.current = false;
            onOpenChange(false);
            onSidebar();
          }}
        >
          <PanelRightOpen className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <PopoverContent
        align="end"
        aria-label={label}
        className="w-[min(29rem,calc(100vw-1rem))] overflow-hidden p-0"
        style={{ background: 'var(--popover)' }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancel}
        onPointerLeave={leave}
        onFocusCapture={() => {
          pinned.current = true;
          cancel();
        }}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
