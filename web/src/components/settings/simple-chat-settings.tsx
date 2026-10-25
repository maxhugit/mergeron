import { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import { SettingsSaveBar } from './settings-save-bar';
import { Input } from '@/components/ui/input';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { useTranslation } from 'react-i18next';

interface KeyStatus {
  configured: boolean;
  managed: boolean;
}

interface BackendStatus {
  backend: 'openai' | 'codex';
  configured: boolean;
}

function headers() {
  const authorization = getAuthorizationHeader();
  return {
    'Content-Type': 'application/json',
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

export function SimpleChatSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<KeyStatus>();
  const [backend, setBackend] = useState<'openai' | 'codex'>('openai');
  const [savedBackend, setSavedBackend] = useState<'openai' | 'codex'>(
    'openai',
  );
  const [apiKey, setApiKey] = useState('');
  const [savingBackend, setSavingBackend] = useState(false);
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [backendMessage, setBackendMessage] = useState<string>();
  const [apiKeyMessage, setApiKeyMessage] = useState<string>();
  const [backendError, setBackendError] = useState<string>();
  const [apiKeyError, setApiKeyError] = useState<string>();

  useEffect(() => {
    Promise.all([
      fetch(withBasePath('/api/simple-chat/api-key'), { headers: headers() }),
      fetch(withBasePath('/api/simple-chat/settings'), { headers: headers() }),
    ])
      .then(async ([keyResponse, backendResponse]) => {
        if (!keyResponse.ok || !backendResponse.ok)
          throw new Error(
            `HTTP ${keyResponse.status || backendResponse.status}`,
          );
        const key = (await keyResponse.json()) as KeyStatus;
        const engine = (await backendResponse.json()) as BackendStatus;
        return { key, engine };
      })
      .then(({ key, engine }) => {
        setStatus(key);
        setBackend(engine.backend);
        setSavedBackend(engine.backend);
      })
      .catch(() => setBackendError(t('unableToReadTheSimpleChatSettings')));
  }, [t]);

  const saveBackend = async (value: 'openai' | 'codex') => {
    if (value === savedBackend) return;
    setSavingBackend(true);
    setBackendMessage(undefined);
    setBackendError(undefined);
    try {
      const response = await fetch(withBasePath('/api/simple-chat/settings'), {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ backend: value }),
      });
      const payload = (await response.json().catch(() => ({}))) as
        | BackendStatus
        | { message?: string };
      if (!response.ok)
        throw new Error(
          'message' in payload ? payload.message : `HTTP ${response.status}`,
        );
      setBackend(value);
      setSavedBackend(value);
      setBackendMessage(
        value === 'codex'
          ? t('simpleChatNowUsesCodexCli')
          : t('simpleChatNowUsesTheOpenAiApi'),
      );
    } catch (caught) {
      setBackendError(
        caught instanceof Error ? caught.message : t('unableToSave'),
      );
    } finally {
      setSavingBackend(false);
    }
  };

  const save = async () => {
    if (!apiKey.trim()) return;
    setSavingApiKey(true);
    setApiKeyMessage(undefined);
    setApiKeyError(undefined);
    try {
      const response = await fetch(withBasePath('/api/simple-chat/api-key'), {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const payload = (await response.json().catch(() => ({}))) as KeyStatus & {
        message?: string;
      };
      if (!response.ok)
        throw new Error(payload.message || `HTTP ${response.status}`);
      setStatus(payload);
      setApiKey('');
      setApiKeyMessage(t('theApiKeyHasBeenSavedAndActivated'));
    } catch (caught) {
      setApiKeyError(
        caught instanceof Error ? caught.message : t('unableToSave'),
      );
    } finally {
      setSavingApiKey(false);
    }
  };

  return (
    <section className="space-y-5">
      <div className="rounded-xl border p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <label
              htmlFor="simple-chat-backend"
              className="text-sm font-medium"
            >
              {t('activeEngine')}
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              {backend === 'codex'
                ? t(
                    'usesTheCodexSubscriptionWithTheModelAndReasoningEffortConfiguredForTheProject',
                  )
                : t(
                    'usesTheApiKeySavedBelowAndTheModelSelectedForEachConversation',
                  )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {savingBackend && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            <select
              id="simple-chat-backend"
              value={backend}
              disabled={savingBackend}
              onChange={(event) =>
                setBackend(event.target.value as 'openai' | 'codex')
              }
              className="h-10 min-w-48 cursor-pointer rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="openai">{t('openAiApi')}</option>
              <option value="codex">{t('codexCli')}</option>
            </select>
          </div>
        </div>
        {backendMessage && (
          <p className="mt-3 text-sm text-emerald-600">{backendMessage}</p>
        )}
        {backendError && (
          <p className="mt-3 text-sm text-destructive">{backendError}</p>
        )}
      </div>

      <div className="rounded-xl border p-4">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="text-sm font-semibold">
            {t('openAiApiConfiguration')}
          </h3>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {status?.configured ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                {t('apiKeyConfigured')}
                {status.managed
                  ? t('fromThisInterface')
                  : t('inServerConfiguration')}
              </>
            ) : (
              <>
                <KeyRound className="h-4 w-4 text-amber-500" />
                {t('noApiKeyAvailable')}
              </>
            )}
          </div>
        </div>

        <label
          htmlFor="openai-api-key"
          className="mb-1.5 block text-sm font-medium"
        >
          {t('newOpenAiApiKey')}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="openai-api-key"
            type="password"
            value={apiKey}
            autoComplete="new-password"
            placeholder="sk-proj-…"
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t(
            'theKeyIsSentOverHttpsStoredOnlyOnTheServerWithRestrictivePermissionsAndCanNeverb1c6d8c2',
          )}
        </p>
        {apiKeyMessage && (
          <p className="mt-3 text-sm text-emerald-600">{apiKeyMessage}</p>
        )}
        {apiKeyError && (
          <p className="mt-3 text-sm text-destructive">{apiKeyError}</p>
        )}
      </div>
      <SettingsSaveBar
        dirty={backend !== savedBackend || !!apiKey.trim()}
        saving={savingBackend || savingApiKey}
        onSave={() =>
          void (async () => {
            await saveBackend(backend);
            await save();
          })()
        }
        onDiscard={() => {
          setBackend(savedBackend);
          setApiKey('');
        }}
      />
    </section>
  );
}
