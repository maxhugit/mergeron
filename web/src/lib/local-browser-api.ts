import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

export const LOCAL_BROWSER_CHANNEL = 'mergeron-local-browser-v1';
export interface LocalCommand {
  id: string;
  executionId: string;
  expiresAt: number;
  action: string;
  args: Record<string, unknown>;
}
export interface ExtensionState {
  state: 'pairing' | 'shared' | 'paused';
  epoch?: string;
  url?: string;
  title?: string;
  selection?: { id: string; url: string; tag: string; text: string };
}
export interface LocalPoll {
  dispatch: LocalCommand[];
  approvals: Array<
    Omit<LocalCommand, 'executionId' | 'expiresAt'> & {
      preview?: { url?: string; target?: { tag: string; text: string } };
    }
  >;
}

/** Credentials stay in the authenticated application; never sent to the extension. */
export async function localBrowserApi<T>(
  thread: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(
    withBasePath(`/api/browser-local/${encodeURIComponent(thread)}/${path}`),
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw new Error('LOCAL_BROWSER_ACCESS_OR_OPERATION_FAILED');
  return response.json() as Promise<T>;
}

/** A narrow, bounded RPC. No bearer tokens, cookies, arbitrary scripts or selectors. */
export function extensionRequest<T>(
  action: 'pair' | 'state' | 'execute' | 'revoke',
  payload: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (
        event.source !== window ||
        event.origin !== location.origin ||
        data?.channel !== LOCAL_BROWSER_CHANNEL ||
        data.kind !== 'response' ||
        data.id !== id
      )
        return;
      finish();
      if (
        data.error ||
        (action !== 'execute' && data.result?.error) ||
        JSON.stringify(data).length > 64_000
      )
        reject(new Error('EXTENSION_UNAVAILABLE_OR_DENIED'));
      else resolve(data.result as T);
    };
    const timer = setTimeout(
      () => {
        finish();
        reject(new Error('EXTENSION_TIMEOUT_DO_NOT_RETRY'));
      },
      action === 'execute' ? 10_000 : 3000,
    );
    window.addEventListener('message', receive);
    window.postMessage(
      { channel: LOCAL_BROWSER_CHANNEL, kind: 'request', id, action, payload },
      location.origin,
    );
  });
}
