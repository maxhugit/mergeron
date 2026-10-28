import { CHANNEL, bounded, safeUrl, instanceOrigin } from './protocol.js';
import { extension } from './browser-api.js';
const slots = async () =>
  (await extension.storage.session.get('slots')).slots ?? {};
const save = (value) => extension.storage.session.set({ slots: value });
let operations = Promise.resolve();
async function pageMessage(...args) {
  let timer;
  try {
    return await Promise.race([
      extension.tabs.sendMessage(...args),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error('PAGE_TIMEOUT_DO_NOT_RETRY')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function stop(slot) {
  slot.shared = false;
  const retained = await slots();
  if (retained[slot.id]) {
    retained[slot.id].shared = false;
    await save(retained);
  }
  if (slot.tabId)
    await pageMessage(
      slot.tabId,
      { channel: CHANNEL, action: 'stop', documentId: slot.documentId },
      { frameId: 0 },
    ).catch(() => {});
}
async function run(message, sender) {
  bounded(message);
  const origin = (await extension.storage.local.get('origin')).origin;
  const popup =
    sender.id === extension.runtime.id &&
    sender.url === extension.runtime.getURL('popup.html');
  const all = await slots();
  for (const [id, slot] of Object.entries(all))
    if (Date.now() - slot.touched > 15 * 60_000) {
      await stop(slot);
      delete all[id];
    }
  if (
    sender.id === extension.runtime.id &&
    sender.url === extension.runtime.getURL('options.html')
  ) {
    if (message.action !== 'configure') throw Error('INVALID_OPTIONS_ACTION');
    const next = message.payload?.origin
      ? instanceOrigin(message.payload.origin)
      : null;
    if (
      next &&
      !(await extension.permissions.contains({ origins: [next + '/*'] }))
    )
      throw Error('PERMISSION_REQUIRED');
    for (const slot of Object.values(all)) await stop(slot);
    await extension.storage.session.clear();
    await extension.scripting.unregisterContentScripts();
    await extension.storage.local.clear();
    if (next) {
      await extension.storage.local.set({ origin: next });
      await registerBridge(next);
    }
    if (origin && origin !== next)
      await extension.permissions.remove({ origins: [origin + '/*'] });
    return { ok: true };
  }
  if (
    origin &&
    !(await extension.permissions.contains({ origins: [origin + '/*'] }))
  ) {
    for (const slot of Object.values(all)) await stop(slot);
    await extension.storage.session.clear();
    throw Error('INSTANCE_PERMISSION_REVOKED');
  }
  if (popup) {
    if (message.action === 'popup')
      return {
        origin,
        sessions: Object.values(all).map(
          ({ id, threadId, paired, shared }) => ({
            id,
            threadId,
            paired,
            shared,
          }),
        ),
      };
    if (message.action === 'pause') {
      for (const slot of Object.values(all)) await stop(slot);
      await save(all);
      return { ok: true };
    }
    const slot = all[message.payload?.id];
    if (!slot) throw Error('PAIRING_EXPIRED');
    if (message.action === 'approvePair') {
      if (Date.now() - slot.created > 120_000) throw Error('PAIRING_EXPIRED');
      slot.paired = true;
      await save(all);
      return { ok: true };
    }
    if (!slot.paired) throw Error('PAIRING_REQUIRED');
    if (message.action === 'share') {
      const tab = await extension.tabs.get(message.payload.tabId);
      const url = new URL(safeUrl(tab.url));
      if (
        url.origin === origin ||
        [
          'chromewebstore.google.com',
          'chrome.google.com',
          'microsoftedge.microsoft.com',
        ].includes(url.hostname)
      )
        throw Error('RESTRICTED_TAB');
      await extension.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['tab-agent.js'],
      });
      for (const other of Object.values(all))
        if (other.tabId === tab.id) await stop(other);
      const result = await pageMessage(
        tab.id,
        { channel: CHANNEL, action: 'init' },
        { frameId: 0 },
      );
      Object.assign(slot, {
        tabId: tab.id,
        allowedOrigin: url.origin,
        documentId: result.documentId,
        epoch: crypto.randomUUID(),
        shared: true,
        touched: Date.now(),
        seen: [],
      });
      await save(all);
      return { ok: true };
    }
    if (message.action === 'point') {
      if (!slot.shared) throw Error('NOT_SHARED');
      if (
        new URL((await extension.tabs.get(slot.tabId)).url).origin !==
        slot.allowedOrigin
      )
        throw Error('ORIGIN_CHANGED');
      await pageMessage(
        slot.tabId,
        { channel: CHANNEL, action: 'point', documentId: slot.documentId },
        { frameId: 0 },
      );
      return { ok: true };
    }
    throw Error('INVALID_POPUP_ACTION');
  }
  if (
    !origin ||
    sender.frameId !== 0 ||
    !sender.tab ||
    new URL(sender.url).origin !== origin
  )
    throw Error('INSTANCE_DENIED');
  const { sessionId, threadId } = message.payload ?? {};
  if (typeof sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(sessionId))
    throw Error('INVALID_SESSION');
  if (message.action === 'pair') {
    if (typeof threadId !== 'string' || threadId.length > 100)
      throw Error('INVALID_THREAD');
    if (!all[sessionId]) {
      if (Object.keys(all).length >= 10) throw Error('PAIRING_LIMIT');
      all[sessionId] = {
        id: sessionId,
        threadId,
        mergeronTab: sender.tab.id,
        paired: false,
        shared: false,
        created: Date.now(),
        touched: Date.now(),
      };
      await save(all);
    }
    if (
      all[sessionId].mergeronTab !== sender.tab.id ||
      all[sessionId].threadId !== threadId
    )
      throw Error('SESSION_DENIED');
    return { ok: true };
  }
  const slot = all[sessionId];
  if (!slot || slot.mergeronTab !== sender.tab.id)
    throw Error('PAIRING_REQUIRED');
  slot.touched = Date.now();
  if (message.action === 'revoke') {
    await stop(slot);
    delete all[sessionId];
    await save(all);
    return { ok: true };
  }
  if (message.action === 'state') {
    if (!slot.paired || !slot.shared) {
      await save(all);
      return { state: slot.paired ? 'paused' : 'pairing' };
    }
    try {
      const tab = await extension.tabs.get(slot.tabId);
      if (new URL(tab.url).origin !== slot.allowedOrigin)
        throw Error('ORIGIN_CHANGED');
      const result = await pageMessage(
        slot.tabId,
        { channel: CHANNEL, action: 'state', documentId: slot.documentId },
        { frameId: 0 },
      );
      if (result.authRequired) throw Error('AUTHENTICATION_REQUIRED');
      await save(all);
      return {
        state: 'shared',
        epoch: slot.epoch,
        url: safeUrl(tab.url),
        title: String(tab.title ?? '').slice(0, 200),
        selection: result.selection,
      };
    } catch {
      await stop(slot);
      await save(all);
      return { state: 'paused' };
    }
  }
  if (message.action === 'execute') {
    const command = bounded(message.payload.command, 8000);
    if (
      !slot.paired ||
      !slot.shared ||
      typeof command?.executionId !== 'string' ||
      !Number.isFinite(command.expiresAt) ||
      Date.now() > command.expiresAt ||
      slot.seen.includes(command.executionId)
    )
      throw Error('COMMAND_UNAVAILABLE_DO_NOT_RETRY');
    const tab = await extension.tabs.get(slot.tabId);
    if (new URL(tab.url).origin !== slot.allowedOrigin) {
      slot.shared = false;
      await save(all);
      throw Error('ORIGIN_CHANGED');
    }
    slot.seen.push(command.executionId);
    if (slot.seen.length > 100) slot.seen.shift();
    await save(all); // At-most-once, including a worker termination during execution.
    try {
      return bounded(
        await pageMessage(
          slot.tabId,
          {
            channel: CHANNEL,
            action: 'command',
            documentId: slot.documentId,
            command,
          },
          { frameId: 0 },
        ),
        48000,
      );
    } catch {
      slot.shared = false;
      await save(all);
      return { error: 'EXECUTION_UNCERTAIN_DO_NOT_RETRY' };
    }
  }
  throw Error('INVALID_BRIDGE_ACTION');
}
extension.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.channel !== CHANNEL) return;
  const operation = operations.catch(() => {}).then(() => run(message, sender));
  operations = operation;
  operation.then(respond, () =>
    respond({ error: 'LOCAL_BROWSER_UNAVAILABLE_OR_DENIED_DO_NOT_RETRY' }),
  );
  return true;
});
extension.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading') return;
  operations = operations
    .catch(() => {})
    .then(async () => {
      const all = await slots();
      for (const slot of Object.values(all))
        if (slot.tabId === tabId) await stop(slot);
      await save(all);
    });
});
extension.tabs.onRemoved.addListener((tabId) => {
  operations = operations
    .catch(() => {})
    .then(async () => {
      const all = await slots();
      for (const [id, slot] of Object.entries(all)) {
        if (slot.mergeronTab === tabId) {
          await stop(slot);
          delete all[id];
        } else if (slot.tabId === tabId) await stop(slot);
      }
      await save(all);
    });
});
extension.permissions.onRemoved.addListener(() => {
  operations = operations
    .catch(() => {})
    .then(async () => {
      const origin = (await extension.storage.local.get('origin')).origin;
      if (
        origin &&
        !(await extension.permissions.contains({ origins: [origin + '/*'] }))
      ) {
        for (const slot of Object.values(await slots())) await stop(slot);
        await extension.storage.session.clear();
      }
    });
});

async function registerBridge(origin) {
  const allowed = instanceOrigin(origin);
  if (!(await extension.permissions.contains({ origins: [allowed + '/*'] })))
    return;
  await extension.scripting.registerContentScripts([
    {
      id: 'mergeron-bridge',
      matches: [allowed + '/*'],
      js: ['bridge.js'],
      runAt: 'document_start',
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);
}

// Safari drops dynamic registrations on extension updates. Restore only the
// already configured/authorized origin; never re-pair or re-share a native tab.
const restoreBridge = () => {
  operations = operations
    .catch(() => {})
    .then(async () => {
      for (const slot of Object.values(await slots())) await stop(slot);
      await extension.storage.session.clear();
      await extension.scripting.unregisterContentScripts();
      const origin = (await extension.storage.local.get('origin')).origin;
      if (origin) await registerBridge(origin);
    });
  // A failed recovery remains closed and is recoverable in extension options.
  void operations.catch(() => {});
};
extension.runtime.onInstalled.addListener(restoreBridge);
extension.runtime.onStartup.addListener(restoreBridge);
