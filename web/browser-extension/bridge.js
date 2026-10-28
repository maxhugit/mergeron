// Injected only on the user-authorized Mergeron HTTPS origin, never on a shared site.
(() => {
  if (window !== window.top || globalThis.__mergeronLocalBridge) return;
  globalThis.__mergeronLocalBridge = true;
  const extension = globalThis.browser ?? globalThis.chrome;
  const channel = 'mergeron-local-browser-v1';
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      message?.channel !== channel ||
      message.kind !== 'request' ||
      typeof message.id !== 'string' ||
      message.id.length > 100
    )
      return;
    if (
      !['pair', 'state', 'execute', 'revoke'].includes(message.action) ||
      JSON.stringify(message).length > 64000
    )
      return;
    extension.runtime
      .sendMessage({
        channel,
        action: message.action,
        payload: message.payload,
      })
      .then(
        (result) =>
          window.postMessage(
            { channel, kind: 'response', id: message.id, result },
            location.origin,
          ),
        () =>
          window.postMessage(
            {
              channel,
              kind: 'response',
              id: message.id,
              error: 'EXTENSION_UNAVAILABLE',
            },
            location.origin,
          ),
      );
  });
})();
