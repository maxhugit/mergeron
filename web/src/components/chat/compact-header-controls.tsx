import { useNavigate } from '@tanstack/react-router';
import { ProfileLanguageSwitch } from '@/components/account/profile-language-switch';
import { useState } from 'react';
import {
  EllipsisVertical,
  MonitorCog,
  BookOpen,
  Lightbulb,
  Bug,
  ExternalLink,
} from 'lucide-react';
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

/** The same status and global-actions menu on desktop, tablet and mobile. */
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
  const navigate = useNavigate();
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
        <section
          className="flex flex-wrap items-center justify-between gap-2 text-xs"
          aria-label={th('quota')}
        >
          <span className="font-medium" title={th('quotaHint')}>
            {th('account')}
          </span>
          <span
            role="status"
            className="flex items-center gap-1 whitespace-nowrap"
          >
            <span
              aria-hidden="true"
              className={`size-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-destructive'}`}
            />
            {connected ? t('connected') : t('disconnected')}
          </span>
          <AccountRateLimitBadge showUnavailable compact />
        </section>
        <McpStatusBadge mode="header" />
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
          <Button
            variant="ghost"
            className="w-full justify-start gap-2"
            onClick={() => {
              setOpen(false);
              void navigate({ to: '/help' });
            }}
          >
            <BookOpen className="size-4" aria-hidden="true" />
            {t('platformGuide')}
          </Button>
        </div>
        <div className="border-t pt-1">
          <Button
            asChild
            variant="ghost"
            className="w-full justify-start gap-2"
          >
            <a
              href="https://github.com/maxhugit/mergeron/issues/new?template=feature_request.yml"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Lightbulb className="size-4" aria-hidden="true" />
              {th('suggestImprovement')}
              <ExternalLink className="ml-auto size-3" aria-hidden="true" />
            </a>
          </Button>
          <Button
            asChild
            variant="ghost"
            className="w-full justify-start gap-2"
          >
            <a
              href="https://github.com/maxhugit/mergeron/issues/new?template=bug_report.yml"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Bug className="size-4" aria-hidden="true" />
              {th('reportIncident')}
              <ExternalLink className="ml-auto size-3" aria-hidden="true" />
            </a>
          </Button>
        </div>
        <div className="border-t pt-2">
          <ProfileLanguageSwitch />
        </div>
        <ProfileTextSize compact />
      </PopoverContent>
    </Popover>
  );
}
