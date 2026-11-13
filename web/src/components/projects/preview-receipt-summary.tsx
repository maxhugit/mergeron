import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { previewsVerify } from '@/generated/api';
import type { PreviewReceipt } from '../../../../runtime/preview-receipt.cjs';

export function PreviewReceiptSummary({
  receipt,
  projectId,
  threadId,
  address,
  disabled,
}: {
  receipt?: PreviewReceipt | null;
  projectId: string;
  threadId: string;
  address?: string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation('previews');
  const [error, setError] = useState('');
  const open = async () => {
    if (!address || disabled) return;
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      setError(t('popupBlocked'));
      return;
    }
    tab.opener = null;
    try {
      const { data: result } = await previewsVerify({
        path: { projectId, threadId },
        throwOnError: true,
        meta: { silent: true },
      });
      const url = new URL(result.url);
      if (
        url.protocol !== 'https:' ||
        url.origin !== new URL(address).origin ||
        url.pathname !== '/.__mergeron_preview/open' ||
        url.username ||
        url.password
      )
        throw Error();
      tab.location.replace(url.href);
      setError('');
    } catch {
      tab.close();
      setError(t('unavailable'));
    }
  };
  return (
    <details className="min-w-0 shrink-0 rounded border p-2 text-xs">
      <summary className="cursor-pointer">{t('verification.title')}</summary>
      <p className="my-2 text-muted-foreground">{t('verification.help')}</p>
      {receipt ? (
        <dl className="space-y-1 break-all">
          <dt>{t('verification.generation')}</dt>
          <dd className="font-mono">{receipt.generation}</dd>
          <dt>{t('verification.copy')}</dt>
          <dd>{receipt.copyId ?? t('verification.noCopy')}</dd>
          <dt>{t('verification.commit')}</dt>
          <dd className="font-mono">
            {receipt.gitCommit ?? t('verification.unknown')}
          </dd>
          <dt>{t('verification.fingerprint')}</dt>
          <dd className="font-mono">{receipt.sourceFingerprint}</dd>
          <dt>{t('lastSync')}</dt>
          <dd>
            {receipt.syncedAt
              ? new Date(receipt.syncedAt).toLocaleString()
              : t('verification.unknown')}
          </dd>
        </dl>
      ) : (
        <p>{t('verification.missing')}</p>
      )}
      <Button
        className="mt-2 h-auto whitespace-normal"
        size="sm"
        variant="outline"
        disabled={disabled || !address}
        onClick={() => void open()}
      >
        {t('verification.open')}
      </Button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
