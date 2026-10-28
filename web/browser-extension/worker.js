import { CHANNEL, bounded, safeUrl, instanceOrigin } from './protocol.js';
import { extension } from './browser-api.js';
const slots = async () =>
  (await extension.storage.session.get('slots')).slots ?? {};
const save = (value) => extension.storage.session.set({ slots: value });
let operations = Promise.resolve();
// Raw pixels never enter the page bridge or durable storage. They are consumed
// once by the bound extension editor; a worker restart deliberately loses them.
const captures = new Map();
function clearDraft(slot) {
  if (slot.draft) captures.delete(slot.draft.id);
  delete slot.draft;
  delete slot.pointingUntil;
}
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
  clearDraft(slot);
  const retained = await slots();
  if (retained[slot.id]) {
    retained[slot.id].shared = false;
    clearDraft(retained[slot.id]);
    await save(retained);
  }
  if (slot.tabId)
    await pageMessage(
      slot.tabId,
      { channel: CHANNEL, action: 'stop', documentId: slot.documentId },
      { frameId: 0 },
    ).catch(() => {});
}
/** A toolbar gesture grants activeTab for this tab only. Never follow navigation in the background. */
async function shareTab(all, slot, tabId, origin) {
  const tab = await extension.tabs.get(tabId);
  const url = new URL(safeUrl(tab.url));
  if (
    !tab.active ||
    [
      'chromewebstore.google.com',
      'chrome.google.com',
      'microsoftedge.microsoft.com',
    ].includes(url.hostname)
  )
    throw Error('RESTRICTED_OR_INACTIVE_TAB');
  const affected = Object.values(all).filter(
    (other) => other.id === slot.id || other.tabId === tab.id,
  );
  // Switching targets must not silently destroy a capture awaiting confirmation/delivery.
  if (affected.some((other) => other.draft || other.annotation))
    throw Error('ANNOTATION_PENDING');
  for (const other of affected) await stop(other);
  await save(all);
  await extension.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['tab-agent.js'],
  });
  const result = await pageMessage(
    tab.id,
    { channel: CHANNEL, action: 'init', annotationOnly: url.origin === origin },
    { frameId: 0 },
  );
  if (result?.protocolVersion !== 3 || typeof result.documentId !== 'string')
    throw Error('RELOAD_TARGET_PAGE_AFTER_EXTENSION_UPDATE');
  // Every explicit resume invalidates document handles AND already-dispatched commands.
  Object.assign(slot, {
    tabId: tab.id,
    allowedOrigin: url.origin,
    documentId: result.documentId,
    epoch: crypto.randomUUID(),
    shared: true,
    touched: Date.now(),
    seen: [],
    annotationOnly: url.origin === origin,
  });
  await save(all);
}
async function run(message, sender) {
  const editor =
    sender.id === extension.runtime.id &&
    sender.url?.split('#')[0] === extension.runtime.getURL('annotation.html');
  bounded(
    message,
    editor && message.action === 'annotationSubmit' ? 800_000 : 64_000,
  );
  const origin = (await extension.storage.local.get('origin')).origin;
  const popup =
    sender.id === extension.runtime.id &&
    sender.url === extension.runtime.getURL('popup.html');
  const all = await slots();
  for (const [id, value] of captures)
    if (Date.now() - value.created > 120_000) captures.delete(id);
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
  if (message.action === 'captureAnnotation') {
    const payload = bounded(message.payload, 48_000);
    const slot = Object.values(all).find(
      (slot) =>
        slot.tabId === sender.tab?.id &&
        slot.documentId === payload.documentId &&
        slot.paired &&
        slot.shared,
    );
    if (
      sender.id !== extension.runtime.id ||
      sender.frameId !== 0 ||
      !slot ||
      slot.pointingUntil < Date.now() ||
      !slot.pointingUntil ||
      slot.draft ||
      slot.annotation ||
      new URL(sender.url).origin !== slot.allowedOrigin ||
      !/^[a-f0-9-]{36}$/.test(payload.selection?.id ?? '') ||
      payload.selection.url !== safeUrl(sender.url) ||
      typeof payload.selection.text !== 'string' ||
      typeof payload.selection.tag !== 'string' ||
      !payload.geometry?.box ||
      !Array.isArray(payload.geometry.masks) ||
      captures.size >= 2
    )
      throw Error('ANNOTATION_DENIED');
    delete slot.pointingUntil; // One physical click, no replay.
    const draft = {
      id: payload.selection.id,
      created: Date.now(),
      documentId: slot.documentId,
      selection: {
        id: payload.selection.id,
        url: payload.selection.url,
        text: payload.selection.text.slice(0, 160),
        tag: payload.selection.tag.slice(0, 30),
        capturedAt: String(payload.selection.capturedAt).slice(0, 40),
      },
      geometry: payload.geometry,
    };
    slot.draft = draft;
    await save(all);
    try {
      const tab = await extension.tabs.get(slot.tabId);
      if (!tab.active || new URL(tab.url).origin !== slot.allowedOrigin)
        throw Error('TAB_NOT_ACTIVE');
      const image = await extension.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: 75,
      });
      const check = await pageMessage(
        slot.tabId,
        {
          channel: CHANNEL,
          action: 'captureCheck',
          documentId: slot.documentId,
          id: draft.id,
        },
        { frameId: 0 },
      );
      const after = await extension.tabs.get(slot.tabId);
      if (
        !check?.ok ||
        !after.active ||
        after.windowId !== tab.windowId ||
        safeUrl(after.url) !== draft.selection.url ||
        typeof image !== 'string' ||
        image.length > 4_000_000 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)
      )
        throw Error('CAPTURE_CHANGED_OR_UNAVAILABLE');
      captures.set(draft.id, { image, created: Date.now() });
      const url = extension.runtime.getURL('annotation.html') + '#' + draft.id;
      let editorTab;
      try {
        const window = await extension.windows.create({
          url,
          type: 'popup',
          width: 600,
          height: 780,
        });
        editorTab = window.tabs?.[0];
        if (!editorTab && window.id)
          editorTab = (await extension.tabs.query({ windowId: window.id }))[0];
      } catch {
        // Some Safari configurations disallow popup windows; an extension-owned
        // normal tab provides the exact same private editor without site injection.
      }
      if (!editorTab?.id)
        editorTab = await extension.tabs.create({ url, active: true });
      draft.editorTabId = editorTab.id;
      await save(all);
      return { ok: true };
    } catch {
      clearDraft(slot);
      await save(all);
      throw Error('CAPTURE_FAILED_NOT_SENT');
    }
  }
  if (editor) {
    const id = message.payload?.draftId;
    const slot = Object.values(all).find(
      (slot) =>
        slot.draft?.id === id &&
        slot.draft.editorTabId === sender.tab?.id &&
        sender.url?.split('#')[0] ===
          extension.runtime.getURL('annotation.html'),
    );
    if (
      !slot ||
      !slot.shared ||
      !slot.paired ||
      Date.now() - slot.draft.created > 10 * 60_000
    )
      throw Error('ANNOTATION_EXPIRED');
    const draft = slot.draft;
    if (message.action === 'annotationCancel') {
      clearDraft(slot);
      await save(all);
      return { ok: true };
    }
    if (message.action === 'annotationOpen') {
      const raw = captures.get(id);
      captures.delete(id);
      if (!raw) throw Error('CAPTURE_EXPIRED');
      return {
        threadId: slot.threadId,
        selection: draft.selection,
        geometry: draft.geometry,
        image: raw.image,
      };
    }
    if (message.action === 'annotationSubmit') {
      const { image, comment } = message.payload;
      if (
        typeof comment !== 'string' ||
        comment.length > 2000 ||
        typeof image !== 'string' ||
        image.length > 750_000 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) ||
        Object.values(all).filter((slot) => slot.annotation).length >= 3
      )
        throw Error('INVALID_ANNOTATION');
      const tab = await extension.tabs.get(slot.tabId);
      if (
        new URL(tab.url).origin !== slot.allowedOrigin ||
        slot.documentId !== draft.documentId
      )
        throw Error('SOURCE_CHANGED');
      slot.annotation = {
        id,
        selection: draft.selection,
        comment: comment.trim(),
        image,
        created: Date.now(),
      };
      clearDraft(slot);
      await save(all);
      // Explicit screenshot confirmation returns the user to the normal message composer.
      await extension.tabs
        .update(slot.mergeronTab, { active: true })
        .catch(() => {});
      return { ok: true };
    }
    throw Error('INVALID_EDITOR_ACTION');
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
      await shareTab(all, slot, message.payload.tabId, origin);
      return { ok: true };
    }
    if (message.action === 'point') {
      if (slot.annotationProtocol !== 3)
        throw Error('UPDATE_MERGERON_FOR_ANNOTATIONS');
      await shareTab(all, slot, message.payload.tabId ?? slot.tabId, origin);
      slot.pointingUntil = Date.now() + 60_000;
      await save(all);
      const result = await pageMessage(
        slot.tabId,
        { channel: CHANNEL, action: 'point', documentId: slot.documentId },
        { frameId: 0 },
      );
      if (!result?.ok) {
        await stop(slot);
        await save(all);
        throw Error('POINT_UNAVAILABLE');
      }
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
        annotationProtocol: message.payload.annotationProtocol,
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
  if (message.action === 'annotation' || message.action === 'annotationAck') {
    if (
      !slot.paired ||
      !slot.annotation ||
      slot.annotation.id !== message.payload.annotationId ||
      Date.now() - slot.annotation.created > 15 * 60_000
    )
      throw Error('ANNOTATION_UNAVAILABLE');
    if (message.action === 'annotationAck') {
      delete slot.annotation;
      await save(all);
      return { ok: true };
    }
    return slot.annotation;
  }
  if (message.action === 'state') {
    if (slot.annotation && Date.now() - slot.annotation.created > 15 * 60_000)
      delete slot.annotation;
    const annotation = slot.annotation
      ? { id: slot.annotation.id, text: slot.annotation.comment }
      : undefined;
    if (!slot.paired || !slot.shared) {
      await save(all);
      return { state: slot.paired ? 'paused' : 'pairing', annotation };
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
      if (!result || result.error || result.authRequired)
        throw Error('AUTHENTICATION_REQUIRED_OR_PAGE_UNAVAILABLE');
      if (!result.pointing) delete slot.pointingUntil;
      await save(all);
      return {
        state: 'shared',
        epoch: slot.epoch,
        url: safeUrl(tab.url),
        title: String(tab.title ?? '').slice(0, 200),
        annotation,
        annotationOnly: slot.annotationOnly,
        inputBlocked: Boolean(slot.pointingUntil > Date.now() || slot.draft),
      };
    } catch {
      await stop(slot);
      await save(all);
      return { state: 'paused', annotation };
    }
  }
  if (message.action === 'execute') {
    const command = bounded(message.payload.command, 8000);
    if (
      !slot.paired ||
      !slot.shared ||
      command.epoch !== slot.epoch ||
      slot.annotationOnly ||
      slot.draft ||
      slot.pointingUntil > Date.now() ||
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
  operation.then(respond, (error) =>
    respond({
      error: [
        'UPDATE_MERGERON_FOR_ANNOTATIONS',
        'RELOAD_TARGET_PAGE_AFTER_EXTENSION_UPDATE',
      ].includes(error?.message)
        ? error.message
        : 'LOCAL_BROWSER_UNAVAILABLE_OR_DENIED_DO_NOT_RETRY',
    }),
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
        if (slot.draft?.editorTabId === tabId) clearDraft(slot);
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
