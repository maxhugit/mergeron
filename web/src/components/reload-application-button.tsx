import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { reloadApplication } from '@/lib/reload-application';
import { useComposerDraftStore } from '@/stores/composer-draft-store';
import { useSnackbarStore } from '@/stores/snackbar-store';

export function ReloadApplicationButton({
  labelled = false,
}: {
  labelled?: boolean;
}) {
  const { t } = useTranslation('pwa');
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    if (busy) return;
    if (
      Object.keys(useComposerDraftStore.getState().drafts).length &&
      !window.confirm(t('reloadDraftWarning'))
    )
      return;
    setBusy(true);
    try {
      await reloadApplication();
    } catch {
      useSnackbarStore.getState().show(t('reloadFailed'), 'error');
      setBusy(false);
    }
  };
  const button = (
    <Button
      type="button"
      size={labelled ? 'default' : 'icon'}
      variant="ghost"
      className={labelled ? 'w-full justify-start gap-2' : 'h-8 w-8 shrink-0'}
      aria-label={t('reload')}
      aria-busy={busy}
      disabled={busy}
      onClick={() => void reload()}
    >
      <RefreshCw
        className={`h-4 w-4${busy ? ' animate-spin' : ''}`}
        aria-hidden="true"
      />
      {labelled && t('reload')}
    </Button>
  );
  if (labelled) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{t('reloadHelp')}</TooltipContent>
    </Tooltip>
  );
}
