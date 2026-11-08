/** Login dialog for the managed ChatGPT device-code flow. */
import { useEffect, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { accountLogin, accountCancelLogin } from '@/generated/api/sdk.gen';
import { showSnackbar } from '@/stores/snackbar-store';
import { useAccountStore } from '@/stores/account-store';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}

interface DeviceCodeState {
  type: 'chatgptDeviceCode';
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export function AccountLoginDialog({ open, onOpenChange, onChanged }: Props) {
  const { t } = useTranslation();
  const setLoginStarted = useAccountStore((s) => s.setLoginStarted);
  const clearLogin = useAccountStore((s) => s.clearLogin);
  const loginState = useAccountStore((s) => s.login);
  const [deviceResponse, setDeviceResponse] = useState<DeviceCodeState | null>(
    null,
  );

  const loginMutation = useMutation({
    mutationFn: async () => {
      const body = { type: 'chatgptDeviceCode' as const };
      const { data } = await accountLogin({ body, throwOnError: true });
      return data;
    },
    onSuccess: (response) => {
      setLoginStarted(response);
      if (
        response.type === 'chatgptDeviceCode' &&
        response.loginId &&
        response.verificationUrl &&
        response.userCode
      ) {
        setDeviceResponse({
          type: 'chatgptDeviceCode',
          loginId: response.loginId,
          verificationUrl: response.verificationUrl,
          userCode: response.userCode,
        });
        return;
      }
      showSnackbar(t('codexAccountUpdated'), 'success');
      onChanged();
      onOpenChange(false);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (loginId: string) =>
      accountCancelLogin({ body: { loginId }, throwOnError: true }),
    onSuccess: () => {
      clearLogin();
      setDeviceResponse(null);
      showSnackbar(t('loginCancelled'), 'info');
    },
  });

  // Handle device-code login completion from websocket notification.
  useEffect(() => {
    const result = loginState.lastResult;
    if (!result) return;
    if (result.success) {
      onChanged();
      onOpenChange(false);
    }
    clearLogin();
  }, [loginState.lastResult, onChanged, onOpenChange, clearLogin]);

  const pending = loginMutation.isPending || cancelMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle>{t('loginToCodex')}</DialogTitle>
          <DialogDescription className="break-words">
            {t('startADeviceCodeLoginAndCompleteItInYourBrowser')}
          </DialogDescription>
        </DialogHeader>

        {deviceResponse ? (
          <div className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <p className="text-muted-foreground">
              {t('openTheVerificationUrlAndEnterThisCode')}
            </p>
            <div className="break-all rounded-md bg-background px-3 py-2 text-center font-mono text-lg tracking-widest">
              {deviceResponse.userCode}
            </div>
            <a
              href={deviceResponse.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-1 text-sm text-primary underline underline-offset-4"
            >
              <span className="min-w-0 break-all">
                {deviceResponse.verificationUrl}
              </span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </a>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {t('startADeviceCodeLoginAndCompleteItInYourBrowser')}
          </p>
        )}

        <DialogFooter className="min-w-0 sm:flex-wrap">
          {deviceResponse ? (
            <Button
              className="h-auto min-w-0 max-w-full whitespace-normal py-2"
              variant="outline"
              disabled={pending}
              onClick={() => cancelMutation.mutate(deviceResponse.loginId)}
            >
              {t('cancelLogin')}
            </Button>
          ) : null}
          <Button
            className="h-auto min-w-0 max-w-full whitespace-normal py-2"
            disabled={pending || Boolean(deviceResponse)}
            onClick={() => loginMutation.mutate()}
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('startDeviceLogin')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
