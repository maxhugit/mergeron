import { useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SettingsPanelContext } from './settings-panel-context';

/** Fixed heading/navigation and actions surround one independently scrolling body. */
export function SettingsPanel({
  heading,
  navigation,
  children,
  contentId,
  labelledBy,
}: {
  contentId?: string;
  labelledBy?: string;
  heading?: ReactNode;
  navigation?: ReactNode;
  children: ReactNode;
}) {
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  return (
    <SettingsPanelContext value={{ footer }}>
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card/40"
        data-settings-panel
      >
        {heading && (
          <header
            className="shrink-0 space-y-1 border-b bg-card px-4 py-4 sm:px-5"
            data-settings-heading
          >
            {heading}
          </header>
        )}
        {navigation && (
          <div className="shrink-0 border-b px-3" data-settings-navigation>
            {navigation}
          </div>
        )}
        <div
          id={contentId}
          role={labelledBy ? 'tabpanel' : undefined}
          aria-labelledby={labelledBy}
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-5"
          data-settings-body
        >
          {children}
        </div>
        <div
          ref={setFooter}
          className="relative z-10 flex shrink-0 flex-wrap items-center justify-end gap-3 border-t bg-card px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] empty:hidden [&_button]:h-auto [&_button]:min-h-8 [&_button]:max-w-full [&_button]:whitespace-normal sm:px-5"
          data-settings-actions
        />
      </section>
    </SettingsPanelContext>
  );
}

/** Keeps existing dialogs, disabled states and click handlers in their original form. */
export function SettingsPanelActions({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  const panel = useContext(SettingsPanelContext);
  if (!active) return null;
  if (!panel) return <>{children}</>;
  return panel.footer ? createPortal(children, panel.footer) : null;
}

/** Standalone consumers retain their heading; embedded panels provide a fixed one. */
export function SettingsStandaloneIntro({ children }: { children: ReactNode }) {
  const panel = useContext(SettingsPanelContext);
  return panel ? null : <>{children}</>;
}

export function SettingsPanelTabs({
  label,
  value,
  items,
  onChange,
  contentId,
}: {
  label: string;
  value: string;
  items: readonly { id: string; label: string }[];
  onChange: (value: string) => void;
  contentId: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex flex-wrap gap-1"
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
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : (current +
                  (event.key === 'ArrowRight' ? 1 : -1) +
                  tabs.length) %
                tabs.length;
        event.preventDefault();
        tabs[index]?.click();
        tabs[index]?.focus();
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`${contentId}-${item.id}`}
          aria-controls={contentId}
          aria-selected={value === item.id}
          tabIndex={value === item.id ? 0 : -1}
          className={`min-h-10 border-b-2 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring ${value === item.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
