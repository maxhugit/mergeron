import { useTranslation } from 'react-i18next';
/** Server-wide runtime settings. */
import { useState } from 'react';
import { BadgeInfo, History, Archive, Boxes } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ServerCapabilities } from './server-capabilities';
import { ServerVersionCard } from './server-version-card';

export function GeneralSettings() {
  const { t: tm } = useTranslation('manager');
  const [tab, setTab] = useState<
    'current' | 'update' | 'backups' | 'capabilities'
  >('current');

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 min-w-0 shrink-0 items-center border-b bg-background">
        <div
          role="tablist"
          aria-label={tm('serverSettingsTabs')}
          className="flex min-w-0 flex-1 items-center overflow-x-auto"
          onKeyDown={(event) => {
            if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key))
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
          {(
            [
              ['current', 'serverCurrentVersionTab', BadgeInfo],
              ['update', 'serverUpdateTab', History],
              ['backups', 'serverBackupTab', Archive],
              ['capabilities', 'capabilitiesTitle', Boxes],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              id={`server-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls={`server-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              className={cn(
                'flex h-10 shrink-0 cursor-pointer items-center gap-2 border-b-2 px-3 text-xs transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]',
                tab === id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              {tm(label)}
            </button>
          ))}
        </div>
      </div>
      <div
        className={cn(
          'min-h-0 flex-1',
          tab === 'current' || tab === 'backups'
            ? 'flex flex-col overflow-hidden'
            : 'overflow-y-auto',
        )}
      >
        <div
          className={cn(
            'mx-auto w-full min-w-0 px-4 py-4 sm:px-6',
            tab === 'current' || tab === 'backups'
              ? 'flex min-h-0 flex-1 flex-col'
              : 'space-y-4',
            tab === 'backups' ? undefined : 'max-w-7xl',
          )}
        >
          {/* Keep update controls mounted so changing tabs cannot reset a plan or its progress dialog. */}
          <div
            className={
              tab === 'current' || tab === 'backups'
                ? 'flex min-h-0 flex-1 flex-col'
                : undefined
            }
            role="tabpanel"
            id={`server-panel-${tab}`}
            aria-labelledby={`server-tab-${tab}`}
          >
            <div
              hidden={tab === 'capabilities'}
              className={
                tab === 'current' || tab === 'backups'
                  ? 'flex min-h-0 flex-1 flex-col'
                  : undefined
              }
            >
              <ServerVersionCard
                view={tab === 'capabilities' ? 'current' : tab}
              />
            </div>
            {tab === 'capabilities' && <ServerCapabilities />}
          </div>
        </div>
      </div>
    </section>
  );
}
