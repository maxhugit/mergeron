import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { reloadApplication } from '@/lib/reload-application';

export function ReloadApplicationButton() {
  const { t } = useTranslation('pwa');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          aria-label={t('reload')}
          onClick={reloadApplication}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('reloadHelp')}</TooltipContent>
    </Tooltip>
  );
}
