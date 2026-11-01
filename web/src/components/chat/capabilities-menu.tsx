import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { McpStatusBadge } from './mcp-status-badge';
import { ServiceTierSelector } from './service-tier-selector';
import { ResponseDetailSelector } from './response-detail-selector';
import { SkillSelector, type SkillSelection } from './skill-selector';

interface Props {
  threadId?: string | null;
  cwd: string | null;
  disabled?: boolean;
  onSelectSkill: (skill: SkillSelection) => void;
}

/** Groups optional execution controls so the composer stays compact. */
export function CapabilitiesMenu({
  threadId,
  cwd,
  disabled,
  onSelectSkill,
}: Props) {
  const { t } = useTranslation();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-lg px-2 text-xs"
          title={t('chatCapabilities')}
          aria-label={t('chatCapabilities')}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span className="hidden @min-[900px]/composer:inline">
            {t('chatCapabilities')}
          </span>
          <ChevronDown className="hidden h-3 w-3 opacity-50 @min-[900px]/composer:block" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 space-y-1 p-2">
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
          {t('chatCapabilities')}
        </p>
        <McpStatusBadge threadId={threadId} menuItem />
        <SkillSelector
          cwd={cwd}
          disabled={disabled}
          menuItem
          onSelect={onSelectSkill}
        />
        <ServiceTierSelector menuItem />
        <ResponseDetailSelector disabled={disabled} />
      </PopoverContent>
    </Popover>
  );
}
