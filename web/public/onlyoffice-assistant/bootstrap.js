/* The official Docs SDK evaluates its parent-supplied initialization code.
 * Pin that protocol to the configured Docs parent BEFORE loading the SDK.
 * Never allow an opener, sibling frame or arbitrary website to initialize it.
 */
(() => {
  'use strict';
  const officeOrigin = document.currentScript.dataset.officeOrigin;
  window.addEventListener(
    'message',
    (event) => {
      if (event.data?.type === 'mergeron.onlyoffice.response') {
        if (event.origin !== location.origin || event.source !== window.top)
          event.stopImmediatePropagation();
        return;
      }
      if (event.origin !== officeOrigin || event.source !== window.parent)
        event.stopImmediatePropagation();
    },
    true,
  );
})();
