import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

export interface OfficeAssistantBridge {
  sessionId: string;
  channel: string;
}

/** The plugin never receives a platform credential, a session id or an arbitrary HTTP proxy. */
export function connectOfficeAssistant(bridge: OfficeAssistantBridge) {
  const abort = new AbortController();
  let source: Window | null = null;
  const pending = new Set<string>();
  const listener = (event: MessageEvent) => {
    const request = event.data;
    if (
      event.origin !== window.location.origin ||
      !event.source ||
      request?.type !== 'mergeron.onlyoffice.request' ||
      request.channel !== bridge.channel ||
      typeof request.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(request.id)
    )
      return;
    const sender = event.source as Window;
    try {
      if (sender === window || sender.top !== window.top) return;
    } catch {
      return;
    }
    if (source && sender !== source) {
      // OnlyOffice destroys the iframe when its panel closes. A new panel may
      // reconnect only after that old window is gone, using this editor's channel.
      try {
        if (!source.closed || request.method !== 'context') return;
      } catch {
        return;
      }
    }
    if (
      !['context', 'propose', 'read'].includes(request.method) ||
      pending.has(request.id) ||
      pending.size >= 4
    )
      return;
    source = sender;
    pending.add(request.id);
    void (async () => {
      try {
        let url = '/api/onlyoffice/assistant/context';
        let body: Record<string, unknown> = { sessionId: bridge.sessionId };
        if (request.method === 'propose') {
          const args = request.args ?? {};
          url = '/api/onlyoffice/assistant/proposals';
          body = {
            ...body,
            threadId: args.threadId,
            instruction: args.instruction,
            action: args.action,
            context: args.context,
            selection: args.selection,
            requestId: args.requestId,
          };
        } else if (request.method === 'read') {
          if (
            typeof request.args?.id !== 'string' ||
            !/^[a-f0-9-]{36}$/.test(request.args.id)
          )
            throw Error('Invalid proposal');
          url = `/api/onlyoffice/assistant/proposals/${request.args.id}`;
        }
        const authorization = getAuthorizationHeader();
        const response = await fetch(withBasePath(url), {
          method: 'POST',
          signal: abort.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(authorization ? { Authorization: authorization } : {}),
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error('Assistant unavailable');
        const result: unknown = await response.json();
        if (!abort.signal.aborted)
          sender.postMessage(
            {
              type: 'mergeron.onlyoffice.response',
              channel: bridge.channel,
              id: request.id,
              result,
            },
            window.location.origin,
          );
      } catch {
        if (!abort.signal.aborted)
          sender.postMessage(
            {
              type: 'mergeron.onlyoffice.response',
              channel: bridge.channel,
              id: request.id,
              error: true,
            },
            window.location.origin,
          );
      } finally {
        pending.delete(request.id);
      }
    })();
  };
  window.addEventListener('message', listener);
  return () => {
    abort.abort();
    window.removeEventListener('message', listener);
  };
}
