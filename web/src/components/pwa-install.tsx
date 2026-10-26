import { useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { promptPwaInstall, usePwaInstall } from '@/lib/pwa-install';

export function PwaInstall() {
  const { t } = useTranslation('pwa');
  const installed = usePwaInstall((state) => state.installed);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section className="space-y-2 border-t pt-4">
      <Button
        variant="outline"
        disabled={installed || busy}
        onClick={() => {
          setBusy(true);
          void promptPwaInstall()
            .then((shown) => {
              if (!shown) setHelp(true);
            })
            .catch(() => setHelp(true))
            .finally(() => setBusy(false));
        }}
      >
        <Download />
        {t(installed ? 'installed' : 'install')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('description')}</p>
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('install')}</DialogTitle>
            <DialogDescription>{t('manualIntroduction')}</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-3 pl-5 text-sm">
            <li>{t('edge')}</li>
            <li>{t('safari')}</li>
          </ul>
          <p className="text-sm text-muted-foreground">{t('availability')}</p>
        </DialogContent>
      </Dialog>
    </section>
  );
}
