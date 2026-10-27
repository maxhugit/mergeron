import { DropdownMenu } from 'radix-ui';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Ref } from 'react';

export function WorkspaceEntryMenu({
  label,
  items,
  triggerRef,
  onCloseAutoFocus,
}: {
  label: string;
  triggerRef?: Ref<HTMLButtonElement>;
  onCloseAutoFocus?: (event: Event) => void;
  items: Array<{
    label: string;
    disabled?: boolean;
    reason?: string;
    destructive?: boolean;
    onSelect: () => void;
  }>;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon-sm"
          aria-label={label}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          onCloseAutoFocus={onCloseAutoFocus}
          className="z-50 max-h-[70vh] max-w-[min(320px,90vw)] overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              disabled={item.disabled}
              title={item.reason}
              onSelect={item.onSelect}
              className={`cursor-default rounded px-3 py-2 text-xs outline-none focus:bg-accent data-[disabled]:opacity-50 ${item.destructive ? 'text-destructive' : ''}`}
            >
              {item.label}
              {item.disabled && item.reason && (
                <span className="mt-1 block max-w-64 text-[10px] text-muted-foreground">
                  {item.reason}
                </span>
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
