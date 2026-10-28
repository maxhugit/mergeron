import { useTranslation } from 'react-i18next';
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (mode: 'isolated' | 'local') => void;
}) {
  const { t } = useTranslation('browser');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('chooseMode')}</DialogTitle>
          <DialogDescription>{t('chooseModeDescription')}</DialogDescription>
        </DialogHeader>
        {(['isolated', 'local'] as const).map((mode) => (
          <Button key={mode} variant="outline" onClick={() => onChoose(mode)}>
            {t(mode === 'local' ? 'localTitle' : 'isolatedTitle')}
          </Button>
        ))}
      </DialogContent>
    </Dialog>
  );
}
