/** Login route component for local sessions and API-key fallback. */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { LoginPage } from '@/components/login';
import { SnackbarContainer } from '@/components/snackbar/snackbar-container';
import { authLogin } from '@/generated/api';
import { setApiToken, clearApiToken } from '@/auth-token';
import { resetSocket } from '@/socket';
import { withBasePath } from '@/base-path';
import { useTranslation } from 'react-i18next';
import { readAuthResource, type PlatformSession } from '@/lib/platform-session';
import { acceptVerifiedSession } from '@/lib/session-recovery';
import { notifySessionRenewed, renewalReturnPath } from '@/lib/session-renewal';
import { InitialSetupGate } from '@/components/initial-admin-setup';

interface AuthMethods {
  localEnabled: boolean;
  oidcEnabled: boolean;
  oidcAutoRedirect: boolean;
  apiKeyEnabled: boolean;
}

export function LoginRoute() {
  return (
    <InitialSetupGate>
      <LoginRouteContent />
    </InitialSetupGate>
  );
}

function LoginRouteContent() {
  const navigate = useNavigate();
  const { t } = useTranslation('authentication');
  const { redirect, manual, renew } = useSearch({ from: '/login' });
  const returnTo = renew ? renewalReturnPath : redirect;
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ready = async () => {
      if (renew && !manual) {
        const identity = await readAuthResource<PlatformSession>('me').catch(
          () => null,
        );
        if (cancelled) return;
        if (identity?.active) {
          setCompleted(true);
          notifySessionRenewed();
          return;
        }
      }
      return fetch(withBasePath('/api/auth/methods'), {
        credentials: 'same-origin',
      })
        .then(async (response) => {
          if (response.ok && !cancelled) {
            const next = (await response.json()) as AuthMethods;
            setMethods(next);
            if (next.oidcEnabled && next.oidcAutoRedirect && !manual)
              window.location.assign(
                withBasePath(
                  `/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`,
                ),
              );
          }
        })
        .catch(() => {
          if (!cancelled)
            setMethods({
              localEnabled: false,
              oidcEnabled: false,
              oidcAutoRedirect: false,
              apiKeyEnabled: true,
            });
        });
    };
    void ready();
    return () => {
      cancelled = true;
    };
  }, [manual, returnTo, renew]);

  const handleOidcLogin = useCallback(() => {
    clearApiToken();
    window.location.assign(
      withBasePath(
        `/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`,
      ),
    );
  }, [returnTo]);

  const completeLogin = useCallback(async (): Promise<boolean> => {
    try {
      const identity = await readAuthResource<PlatformSession>('me');
      if (!identity.active) return false;
      if (renew) {
        setCompleted(true);
        notifySessionRenewed();
        return true;
      }
      if (!acceptVerifiedSession(identity)) return false;
      resetSocket();
      void navigate({ to: redirect });
      return true;
    } catch {
      return false;
    }
  }, [navigate, redirect, renew]);

  const handleApiKeyLogin = useCallback(
    async (apiKey: string): Promise<boolean> => {
      try {
        const { data: loginData } = await authLogin({
          body: { apiKey },
          throwOnError: true,
        });
        setApiToken(loginData.accessToken);
        const ok = await completeLogin();
        if (!ok) clearApiToken();
        return ok;
      } catch {
        clearApiToken();
        return false;
      }
    },
    [completeLogin],
  );

  const handleLocalLogin = useCallback(
    async (username: string, password: string): Promise<boolean> => {
      try {
        clearApiToken();
        const response = await fetch(withBasePath('/api/auth/local-login'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        if (!response.ok) return false;
        return completeLogin();
      } catch {
        return false;
      }
    },
    [completeLogin],
  );

  return (
    <>
      {completed ? (
        <p role="status" className="p-6">
          {t('access.renewed')}
        </p>
      ) : methods ? (
        <LoginPage
          localEnabled={methods.localEnabled}
          oidcEnabled={methods.oidcEnabled}
          onOidcLogin={handleOidcLogin}
          onLocalLogin={handleLocalLogin}
          onApiKeyLogin={handleApiKeyLogin}
        />
      ) : (
        <div className="flex h-[var(--app-vh,100dvh)] items-center justify-center bg-background text-sm text-muted-foreground">
          {t('login.loading')}
        </div>
      )}
      <SnackbarContainer />
    </>
  );
}
