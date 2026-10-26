import { useRef, useState, type ReactNode } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
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
    <div>
      <div className="not-prose mb-2 flex justify-start">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          disabled={!completed || empty || busy}
          onClick={() => void copy()}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {t('copyFormatted')}
        </Button>
      </div>
      <div ref={content}>{children}</div>
    </div>
  );
}
