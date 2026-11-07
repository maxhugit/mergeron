import { useState } from 'react';
import { EllipsisVertical, MonitorCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ReloadApplicationButton } from '@/components/reload-application-button';
import { ProfileTextSize } from '@/components/account/profile-text-size';
import { AccountRateLimitBadge } from './account-rate-limit-badge';
import { McpStatusBadge } from './mcp-status-badge';

/** One accessible touch target for mobile/tablet status and global actions. */
export function CompactHeaderControls({
  connected,
  isAdministrator,
  onSettings,
}: {
  connected: boolean;
  isAdministrator: boolean;
  onSettings: () => void;
}) {
  const { t } = useTranslation();
  const { t: th } = useTranslation('headerControls');
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="relative size-9 shrink-0"
          aria-label={t('moreActions')}
          aria-description={connected ? t('connected') : t('disconnected')}
        >
          <EllipsisVertical className="size-5" />
          <span
            aria-hidden="true"
            className={`absolute bottom-1 right-1 size-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-destructive'}`}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        aria-label={th('title')}
        style={{ backgroundColor: 'var(--popover)' }}
        className="w-80 max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-6rem)] space-y-3 overflow-y-auto p-3"
      >
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>{th('connection')}</span>
          <span role="status" className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${connected ? 'bg-green-400' : 'bg-muted-foreground'}`}
            />
            {connected ? t('connected') : t('disconnected')}
          </span>
        </div>
        <section className="space-y-2 text-sm" aria-label={th('quota')}>
          <p title={th('quotaHint')}>{th('quota')}</p>
          <AccountRateLimitBadge showUnavailable />
          <McpStatusBadge mode="header" />
        </section>
        <div className="border-t pt-1">
          <ReloadApplicationButton labelled />
          {isAdministrator && (
            <Button
              variant="ghost"
              className="w-full justify-start gap-2"
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
            >
              <MonitorCog className="size-4" />
              {t('platformSettings')}
            </Button>
          )}
        </div>
        <ProfileTextSize />
      </PopoverContent>
    </Popover>
  );
}
