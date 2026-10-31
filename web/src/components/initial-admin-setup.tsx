/** This gate mounts normal authentication only after the server certifies setup is closed. */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ShieldCheck } from 'lucide-react';
import { withBasePath } from '@/base-path';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BrandIcon } from '@/components/brand-icon';

interface SetupStatus {
  required: boolean;
  authorized: boolean;
  csrfToken?: string;
  containerName?: string;
  completed?: boolean;
}
async function request(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<SetupStatus> {
  const response = await fetch(withBasePath('/api/auth/setup/' + path), {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error('Initial setup unavailable');
  return response.json() as Promise<SetupStatus>;
}
export function InitialSetupGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation('authentication');
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void request('status', undefined, controller.signal)
      .then((value) => {
        if (
          typeof value.required !== 'boolean' ||
          typeof value.authorized !== 'boolean'
        )
          throw new Error('Invalid setup status');
        if (!controller.signal.aborted) setStatus(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [attempt]);
  if (status?.required === false) return children;
  if (!status)
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
        <div role="status" className="space-y-4 text-center">
          <p>{t(error ? 'setup.loadError' : 'setup.loading')}</p>
          {error ? (
            <Button
              onClick={() => {
                setError(false);
                setAttempt((value) => value + 1);
              }}
            >
              {t('setup.retry')}
            </Button>
          ) : (
            <Loader2 className="mx-auto animate-spin" />
          )}
        </div>
      </div>
    );
  return (
    <InitialAdminSetup
      status={status}
      onAuthorized={(csrfToken) =>
        setStatus({ ...status, authorized: true, csrfToken })
      }
      onComplete={() => setStatus({ required: false, authorized: false })}
      onRestart={() => {
        setError(false);
        setStatus(null);
        setAttempt((value) => value + 1);
      }}
    />
  );
}
function InitialAdminSetup({
  status,
  onAuthorized,
  onComplete,
  onRestart,
}: {
  status: SetupStatus;
  onAuthorized: (token: string) => void;
  onComplete: () => void;
  onRestart: () => void;
}) {
  const { t } = useTranslation('authentication');
  const fieldLabels = {
    firstName: t('setup.firstName'),
    lastName: t('setup.lastName'),
    email: t('setup.email'),
    username: t('setup.username'),
    password: t('setup.password'),
    passwordConfirmation: t('setup.passwordConfirmation'),
  };
  const [code, setCode] = useState('');
  const [values, setValues] = useState({
    firstName: '',
    lastName: '',
    email: '',
    username: '',
    password: '',
    passwordConfirmation: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!status.authorized) {
        const result = await request('verify', { code: code.trim() });
        if (!result.authorized || typeof result.csrfToken !== 'string')
          throw new Error('Invalid setup grant');
        setCode('');
        onAuthorized(result.csrfToken);
      } else {
        if (values.password !== values.passwordConfirmation) {
          setError(t('setup.passwordMismatch'));
          return;
        }
        const result = await request('complete', {
          ...values,
          csrfToken: status.csrfToken,
        });
        if (result.completed !== true)
          throw new Error('Setup completion not confirmed');
        setValues({
          firstName: '',
          lastName: '',
          email: '',
          username: '',
          password: '',
          passwordConfirmation: '',
        });
        setDone(true);
      }
    } catch {
      setError(t(status.authorized ? 'setup.createError' : 'setup.codeError'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="min-h-dvh overflow-y-auto bg-background p-4 text-foreground sm:p-8">
      <section className="glass-5 mx-auto my-6 w-full max-w-lg space-y-5 rounded-3xl border p-6 sm:my-12 sm:p-8">
        <div className="flex items-center gap-3 text-xl font-semibold">
          <BrandIcon /> Mergeron
        </div>
        <h1 className="text-2xl font-semibold">
          {t(done ? 'setup.doneTitle' : 'setup.title')}
        </h1>
        {done ? (
          <>
            <p role="status">{t('setup.done')}</p>
            <p className="text-sm text-muted-foreground">
              {t('setup.nextSteps')}
            </p>
            <Button onClick={onComplete}>{t('setup.signIn')}</Button>
          </>
        ) : (
          <form
            onSubmit={(event) => void submit(event)}
            className="space-y-4"
            aria-label={t('setup.title')}
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="size-5 shrink-0" />
              {t(
                status.authorized
                  ? 'setup.accountStep'
                  : 'setup.activationStep',
              )}
            </div>
            {!status.authorized ? (
              <>
                <p>{t('setup.activationHelp')}</p>
                <pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
                  docker exec -it {status.containerName ?? 'mergeron-ui'} node
                  /app/scripts/setup-admin.cjs
                </pre>
                <p className="text-sm text-muted-foreground">
                  {t('setup.codeHelp')}
                </p>
                <label className="block space-y-1">
                  <span>{t('setup.code')}</span>
                  <Input
                    type="password"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    maxLength={128}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    disabled={busy}
                  />
                </label>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {t('setup.accountHelp')}
                </p>
                {(
                  [
                    'firstName',
                    'lastName',
                    'email',
                    'username',
                    'password',
                    'passwordConfirmation',
                  ] as const
                ).map((field) => (
                  <label key={field} className="block space-y-1">
                    <span>{fieldLabels[field]}</span>
                    <Input
                      type={
                        field.startsWith('password')
                          ? 'password'
                          : field === 'email'
                            ? 'email'
                            : 'text'
                      }
                      autoComplete={
                        field.startsWith('password')
                          ? 'new-password'
                          : field === 'username'
                            ? 'username'
                            : field === 'firstName'
                              ? 'given-name'
                              : field === 'lastName'
                                ? 'family-name'
                                : 'email'
                      }
                      required
                      minLength={
                        field.startsWith('password')
                          ? 12
                          : field === 'username'
                            ? 3
                            : 1
                      }
                      maxLength={
                        field.startsWith('password')
                          ? 1024
                          : field === 'email'
                            ? 254
                            : field === 'username'
                              ? 64
                              : 100
                      }
                      value={values[field]}
                      disabled={busy}
                      onChange={(event) =>
                        setValues((before) => ({
                          ...before,
                          [field]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </>
            )}
            {error && (
              <div className="space-y-2 text-sm" role="alert">
                <p className="text-destructive">{error}</p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={onRestart}
                >
                  {t('setup.restart')}
                </Button>
              </div>
            )}
            <Button
              className="w-full"
              type="submit"
              disabled={busy || (!status.authorized && !code.trim())}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t(status.authorized ? 'setup.create' : 'setup.verify')}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
