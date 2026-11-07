import { useTranslation } from 'react-i18next';
import { useServerCapabilities } from '../settings/server-capabilities-api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

export function BrowserModeDialog({
  open,
  onOpenChange,
  onChoose,
  isolatedDisabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (mode: 'isolated' | 'local') => void;
  isolatedDisabled?: boolean;
}) {
  const { t } = useTranslation('browser');
  const { t: tm } = useTranslation('manager');
  const capabilities = useServerCapabilities(open);
  const installed = capabilities.data?.capabilities.find(
    (c) => c.id === 'browser',
  )?.installed;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('chooseMode')}</DialogTitle>
          <DialogDescription>{t('chooseModeDescription')}</DialogDescription>
        </DialogHeader>
        {(['isolated', 'local'] as const).map((mode) => (
          <Button
            key={mode}
            variant="outline"
            disabled={
              mode === 'isolated' && (isolatedDisabled || installed !== true)
            }
            onClick={() => onChoose(mode)}
          >
            {mode === 'isolated' && installed === false
              ? tm('capabilityStates.notInstalled') + ' — ' + t('isolatedTitle')
              : t(mode === 'local' ? 'localTitle' : 'isolatedTitle')}
          </Button>
        ))}
      </DialogContent>
    </Dialog>
  );
}
