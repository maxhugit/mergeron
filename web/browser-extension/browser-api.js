// Safari exposes Promise-based APIs under browser; older Chromium uses chrome.
// Never fall back to persistent storage for the in-memory pairing/command state.
export const extension = globalThis.browser ?? globalThis.chrome;
if (
  !extension?.storage?.session ||
  !extension?.scripting?.registerContentScripts ||
  !extension?.runtime?.sendMessage
)
  throw Error('UNSUPPORTED_BROWSER_SAFARI_18_4_OR_CHROMIUM_120_REQUIRED');
