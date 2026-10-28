import { Fragment, useRef, type ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import { MoreVertical, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

export interface FileMenuAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  separated?: boolean;
}

/** One action list for the row's right-click menu and its explicit overflow button. */
export function FileActionsMenu({
  actions,
  children,
  showButton = true,
  onOpenChange,
  onAction,
  buttonLabel,
}: {
  actions: FileMenuAction[];
  children: ReactNode;
  showButton?: boolean;
  onOpenChange?: (open: boolean) => void;
  onAction?: (id: string) => void;
  buttonLabel?: string;
}) {
  const { t } = useTranslation();
  const pending = useRef<string | null>(null);
  const afterClose = (event: Event) => {
    const action = pending.current;
    pending.current = null;
    if (action) {
      event.preventDefault();
      requestAnimationFrame(() => {
        const entry = actions.find((item) => item.id === action);
        if (entry?.onSelect) entry.onSelect();
        else onAction?.(action);
      });
    }
  };
  const entries = (dropdown: boolean) =>
    actions.map((action) => {
      const Icon = action.icon;
      const content = (
        <>
          <Icon className="h-4 w-4 shrink-0" />
          {action.label}
        </>
      );
      return (
        <Fragment key={action.id}>
          {action.separated &&
            (dropdown ? (
              <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
            ) : (
              <ContextMenuSeparator />
            ))}
          {dropdown ? (
            <DropdownMenu.Item
              disabled={action.disabled}
              className={`relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 ${action.destructive ? 'text-destructive' : ''}`}
              onSelect={() => {
                pending.current = action.id;
              }}
            >
              {content}
            </DropdownMenu.Item>
          ) : (
            <ContextMenuItem
              disabled={action.disabled}
              variant={action.destructive ? 'destructive' : 'default'}
              onSelect={() => {
                pending.current = action.id;
              }}
            >
              {content}
            </ContextMenuItem>
          )}
        </Fragment>
      );
    });
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      <ContextMenu onOpenChange={onOpenChange}>
        <ContextMenuTrigger asChild>
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {children}
            {showButton && (
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label={
                    buttonLabel
                      ? `${t('actions')} · ${buttonLabel}`
                      : t('actions')
                  }
                  className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              </DropdownMenu.Trigger>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          className="max-w-[calc(100vw-1rem)]"
          onCloseAutoFocus={afterClose}
        >
          {entries(false)}
        </ContextMenuContent>
      </ContextMenu>
      {showButton && (
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-48 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
            onCloseAutoFocus={afterClose}
          >
            {entries(true)}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      )}
    </DropdownMenu.Root>
  );
}
