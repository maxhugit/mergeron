/** Runs before the real Next.js client entry. Observes its actual HMR socket. */
(function () {
  if (typeof window === 'undefined' || window.__mergeronNextDiagnostics) return;
  const state = {
    socket: null,
    nonce: null,
    hash: null,
    phase: 'idle',
    updates: 0,
    appliedAt: null,
  };
  Object.defineProperty(window, '__mergeronNextDiagnostics', { value: state });
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      let target;
      try {
        target = new URL(url, location.href);
      } catch {
        /* Native constructor reports the error. */
      }
      const observed =
        target &&
        target.host === location.host &&
        /\/_next\/(?:webpack-hmr|hmr)$/.test(target.pathname);
      let nonce;
      if (observed) {
        nonce = crypto.randomUUID();
        target.searchParams.set('mergeronProbe', nonce);
      }
      super(observed ? target.href : url, protocols);
      if (!observed) return;
      state.socket = this;
      state.nonce = nonce;
      state.hash = null;
      this.addEventListener('message', (event) => {
        if (
          state.socket !== this ||
          typeof event.data !== 'string' ||
          event.data.length > 65536
        )
          return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const action = message.type ?? message.action;
        if (action === 'building') state.phase = 'updating';
        if (!['built', 'sync'].includes(action)) return;
        if (Array.isArray(message.errors) && message.errors.length) {
          state.phase = 'error';
          return;
        }
        if (
          typeof message.hash !== 'string' ||
          !/^[a-f0-9]{16,64}$/.test(message.hash)
        )
          return;
        if (action === 'built' && message.hash !== state.hash) {
          state.updates++;
          state.appliedAt = Date.now();
        }
        state.hash = message.hash;
        state.phase = state.updates ? 'applied' : 'idle';
      });
    }
  };
  let busy = false;
  addEventListener('message', async (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== parent ||
      parent === window ||
      event.data?.type !== 'mergeron-preview:inspect' ||
      typeof event.data.id !== 'string' ||
      event.data.id.length > 64 ||
      busy
    )
      return;
    busy = true;
    try {
      const status = await fetch(
        '/__mergeron_hmr/status?probe=' + encodeURIComponent(state.nonce ?? ''),
        {
          credentials: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        },
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const open = state.socket?.readyState === NativeWebSocket.OPEN;
      const sameBuild = open && state.hash && status?.hash === state.hash;
      parent.postMessage(
        {
          type: 'mergeron-preview:observation',
          id: event.data.id,
          observation: {
            adapter: 'next-webpack',
            detectedGeneration: status?.generation ?? null,
            watching: status?.watching === true,
            socketGeneration: sameBuild ? status.generation : null,
            websocket: !open
              ? 'unavailable'
              : status?.viaPreview
                ? 'connected'
                : 'bypassed',
            phase: ['error', 'updating'].includes(status?.phase)
              ? status.phase
              : state.phase,
            updates: state.updates,
            appliedAt: state.appliedAt,
          },
        },
        location.origin,
      );
    } finally {
      busy = false;
    }
  });
})();
