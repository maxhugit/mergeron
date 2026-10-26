import { useRef, useState, type ReactNode } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { copyFormattedResponse } from '@/lib/formatted-clipboard';
import { showSnackbar } from '@/stores/snackbar-store';

export function CopyResponse({
  children,
  completed,
  empty,
}: {
  children: ReactNode;
  completed: boolean;
  empty: boolean;
}) {
  const { t } = useTranslation();
  const content = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const copy = async () => {
    if (!content.current || busy) return;
    setBusy(true);
    try {
      await copyFormattedResponse(content.current);
      showSnackbar(t('copiedSuccessfully'));
    } catch {
      showSnackbar(t('copyFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="group/response relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hover-reveal not-prose absolute right-0 top-0 z-10 h-7 w-7 text-muted-foreground transition-opacity group-hover/response:opacity-100 group-focus-within/response:opacity-100 focus-visible:opacity-100"
            aria-label={t('copyFormatted')}
            disabled={!completed || empty || busy}
            onClick={() => void copy()}
          >
            {busy ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('copyFormatted')}</TooltipContent>
      </Tooltip>
      <div ref={content} className="pr-9">
        {children}
      </div>
    </div>
  );
}
