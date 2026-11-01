import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { client } from '@/generated/api/client.gen';
import {
  codexConfigReadConfigOptions,
  mcpServersListServersQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import { getApiErrorMessage } from '@/lib/api-error';

interface Config {
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  bearerTokenEnvVar?: string;
  update: boolean;
}
/** A server is configured in this instance; it does not import desktop credentials. */
export function McpConfigDialog({
  name,
  onClose,
}: {
  name: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('integrations');
  const queryClient = useQueryClient();
  const [serverName, setServerName] = useState(name ?? '');
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState<string | undefined>();
  const [tokenEnv, setTokenEnv] = useState('');
  const [saved, setSaved] = useState(false);
  const [registered, setRegistered] = useState(Boolean(name));
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<string | null>(null);
  const configQuery = useQuery({
    ...codexConfigReadConfigOptions(),
    enabled: Boolean(name),
    retry: false,
  });
  const existing = (
    configQuery.data?.config as
      | {
          mcp_servers?: Record<
            string,
            { url?: string; command?: string; args?: string[] }
          >;
        }
      | undefined
  )?.mcp_servers?.[name ?? ''];
  const selectedTransport = name
    ? existing?.command
      ? 'stdio'
      : 'http'
    : transport;
  const save = useMutation({
    mutationFn: async (body: Config) => {
      const { data } = await client.post<
        { 200: { saved: boolean } },
        unknown,
        true
      >({
        url: '/api/mcp-servers/configuration',
        body,
        headers: { 'Content-Type': 'application/json' },
        throwOnError: true,
        ...{ meta: { silent: true } },
      });
      return data;
    },
    onSuccess: () => {
      setSaved(true);
      setRegistered(true);
      void queryClient.invalidateQueries({
        queryKey: codexConfigReadConfigOptions().queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: mcpServersListServersQueryKey(),
      });
    },
    onError: (e) => setError(getApiErrorMessage(e)),
  });
  const check = useMutation({
    mutationFn: async () => {
      const { data } = await client.post<
        {
          200: {
            data: {
              name: string;
              tools?: Record<string, unknown>;
              authStatus?: string;
            }[];
          };
        },
        unknown,
        true
      >({
        url: '/api/mcp-servers/check',
        body: { name: serverName },
        headers: { 'Content-Type': 'application/json' },
        throwOnError: true,
        ...{ meta: { silent: true } },
      });
      return data;
    },
    onSuccess: (data) => {
      const row = data.data.find((row) => row.name === serverName);
      setChecked(
        row
          ? t('serverReported', {
              count: Object.keys(row.tools ?? {}).length,
              auth: row.authStatus ?? '—',
            })
          : t('serverNotReported'),
      );
      void queryClient.invalidateQueries({
        queryKey: mcpServersListServersQueryKey(),
      });
    },
    onError: (e) => setError(getApiErrorMessage(e)),
  });
  const submit = () => {
    setError('');
    let parsed: string[];
    try {
      parsed = JSON.parse(args ?? JSON.stringify(existing?.args ?? []));
      if (!Array.isArray(parsed) || parsed.some((a) => typeof a !== 'string'))
        throw Error();
    } catch {
      setError(t('argumentsInvalid'));
      return;
    }
    save.mutate({
      name: serverName,
      transport: selectedTransport,
      update: registered,
      ...(selectedTransport === 'http'
        ? {
            url: url || existing?.url,
            ...(tokenEnv ? { bearerTokenEnvVar: tokenEnv } : {}),
          }
        : {
            command: command || existing?.command,
            args: parsed,
          }),
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-popover! max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(name ? 'configureServer' : 'addServer')}</DialogTitle>
          <DialogDescription>{t('serverScope')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="grid gap-1 text-sm">
            {t('serverName')}
            <Input
              required
              pattern="[a-z][a-z0-9_-]{0,63}"
              value={serverName}
              disabled={registered}
              onChange={(e) => setServerName(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t('transport')}
            <select
              className="rounded-md border bg-background p-2"
              value={selectedTransport}
              disabled={registered}
              onChange={(e) => setTransport(e.target.value as 'http' | 'stdio')}
            >
              <option value="http">HTTP</option>
              <option value="stdio">{t('localCommand')}</option>
            </select>
          </label>
          {selectedTransport === 'http' ? (
            <>
              <label className="grid gap-1 text-sm">
                {t('serverUrl')}
                <Input
                  type="url"
                  required={!existing?.url}
                  placeholder={existing?.url ?? 'https://mcp.example.com/mcp'}
                  value={url}
                  onChange={(e) => {
                    setSaved(false);
                    setUrl(e.target.value);
                  }}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {t('tokenEnv')}
                <Input
                  pattern="[A-Z_][A-Z0-9_]*"
                  value={tokenEnv}
                  onChange={(e) => {
                    setSaved(false);
                    setTokenEnv(e.target.value);
                  }}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                {t('oauthAfterSave')}
              </p>
            </>
          ) : (
            <>
              <label className="grid gap-1 text-sm">
                {t('command')}
                <Input
                  required={!existing?.command}
                  placeholder={existing?.command}
                  value={command}
                  onChange={(e) => {
                    setSaved(false);
                    setCommand(e.target.value);
                  }}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {t('arguments')}
                <Input
                  value={args ?? JSON.stringify(existing?.args ?? [])}
                  onChange={(e) => {
                    setSaved(false);
                    setArgs(e.target.value);
                  }}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                {t('localCommandHint')}
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="text-sm">
              {t('serverSaved')}
            </p>
          )}
          {checked && (
            <p role="status" className="text-sm">
              {checked}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t('checkReloads')}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('close')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!registered || check.isPending || save.isPending}
              onClick={() => check.mutate()}
            >
              {t('checkServer')}
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending ||
                check.isPending ||
                (Boolean(name) && !existing)
              }
            >
              {t('save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
