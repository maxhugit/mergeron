'use strict';
/** Runs on the dedicated preview origin, with its existing HttpOnly grant. */
function verificationBrowser() {
  const french = navigator.language.startsWith('fr');
  const labels = french
    ? {
        details: 'Relevés techniques',
        hmrApplied: 'CSS actualisé par hot reload ; document HTML conservé',
        downloadAdapter: 'Télécharger l’intégration Vite',
        chain: 'Chaîne du hot reload',
        source: '1. Fichiers synchronisés',
        detection: '2. Changement détecté par le serveur',
        socket: '3. WebSocket du navigateur via la preview',
        applied: '4. Style calculé attendu',
        build: 'Événement de mise à jour du navigateur',
        passed: 'Confirmé',
        failed: 'En échec',
        unknownStage: 'Inconnu / intégration absente',
        pendingStage: 'En attente',
        idleStage: 'Aucune mise à jour observée',
        compiling: 'Mise à jour en cours dans le navigateur',
        buildError: 'Le serveur de développement signale une erreur',
        monitor: 'Surveiller le prochain changement (30 s)',
        monitoring: 'Arrêter la surveillance',
        monitorHelp:
          'Modifiez puis synchronisez les sources. Le diagnostic observe sans recharger la page. L’intégration Vite utilise le vrai canal HMR ; une génération de transfert seule ne prouve pas sa compilation.',
        styleMismatch:
          'Le style calculé ne correspond pas à la valeur attendue',
        title: 'Vérification de la preview',
        check: 'Vérifier sans recharger',
        reload: 'Recharger la page puis vérifier',
        help: 'Ce diagnostic utilise votre accès Mergeron à la preview. La session du site reste indépendante. Les marqueurs applicatifs sont des observations, jamais une autorisation.',
        checking: 'Vérification en cours',
        unavailable:
          'Diagnostic indisponible : la page ou une étape de vérification ne répond pas.',
        accessExpired:
          'Accès Mergeron à la preview expiré ou refusé. Rouvrez depuis Mergeron.',
        frameUnavailable:
          'Page inaccessible au diagnostic : session du site ou protection contre l’intégration à vérifier.',
        current: 'Marqueurs HTML et CSS concordants',
        stale: 'Une génération antérieure est encore affichée',
        unknown:
          'Génération compilée inconnue : marqueurs applicatifs absents ou incomplets',
        cssStale:
          'CSS ancien : le navigateur et la réponse fraîche du serveur diffèrent',
        sourceFailed: 'Synchronisation source non confirmée',
        older: 'La page a été ouverte avant la dernière synchronisation',
        limited: 'Certaines feuilles CSS ne peuvent pas être vérifiées',
        cssCurrent:
          'Les feuilles CSS vérifiées correspondent au serveur actuel',
        expected: 'Style calculé attendu (facultatif)',
        selector: 'Sélecteur CSS',
        property: 'Propriété CSS',
        value: 'Valeur attendue',
        stylePassed: 'Style calculé confirmé',
        styleFailed: 'Style calculé différent ou élément absent',
        buildNote:
          'Une copie reçue ou une réponse HTTP 200 ne prouve pas une recompilation. Les marqueurs doivent être produits par la compilation de l’application.',
      }
    : {
        details: 'Technical observations',
        hmrApplied: 'CSS updated through hot reload; HTML document preserved',
        downloadAdapter: 'Download the Vite integration',
        chain: 'Hot reload chain',
        source: '1. Synchronized files',
        detection: '2. Change detected by the server',
        socket: '3. Browser WebSocket through the preview',
        applied: '4. Expected computed style',
        build: 'Browser update event',
        passed: 'Confirmed',
        failed: 'Failed',
        unknownStage: 'Unknown / integration missing',
        pendingStage: 'Pending',
        idleStage: 'No update observed',
        compiling: 'Browser update in progress',
        buildError: 'The development server reports an error',
        monitor: 'Watch the next change (30 s)',
        monitoring: 'Stop watching',
        monitorHelp:
          'Edit and synchronize the sources. The diagnostic observes without reloading. The Vite integration uses the real HMR channel; a transfer generation alone does not prove compilation.',
        styleMismatch: 'The computed style does not match the expected value',
        title: 'Preview verification',
        check: 'Check without reloading',
        reload: 'Reload the page and check',
        help: 'This diagnostic uses your Mergeron preview access. The site session remains separate. Application markers are observations, never authorization.',
        checking: 'Checking',
        unavailable:
          'Diagnostic unavailable: the page or a verification step is not responding.',
        accessExpired:
          'Mergeron preview access expired or denied. Reopen from Mergeron.',
        frameUnavailable:
          'The diagnostic cannot inspect the page: check the site session or framing protection.',
        current: 'HTML and CSS markers match',
        stale: 'An earlier generation is still displayed',
        unknown:
          'Compiled generation unknown: application markers are missing or incomplete',
        cssStale: 'Stale CSS: the browser and fresh server response differ',
        sourceFailed: 'Source synchronization not confirmed',
        older: 'The page was opened before the latest synchronization',
        limited: 'Some stylesheets cannot be verified',
        cssCurrent: 'Verified stylesheets match the current server response',
        expected: 'Expected computed style (optional)',
        selector: 'CSS selector',
        property: 'CSS property',
        value: 'Expected value',
        stylePassed: 'Computed style confirmed',
        styleFailed: 'Computed style differs or element is absent',
        buildNote:
          'Received files or HTTP 200 do not prove recompilation. Application markers must be produced by the application build.',
      };
  const byId = (id) => document.getElementById(id);
  for (const node of document.querySelectorAll('[data-label]'))
    node.textContent = labels[node.dataset.label];
  document.title = labels.title;
  document.documentElement.lang = french ? 'fr' : 'en';
  let path = new URLSearchParams(location.search).get('path') || '/';
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\\\r\n#]/.test(path) ||
    path.startsWith('/.__mergeron_preview/')
  )
    path = '/';
  const frame = byId('application');
  let loadedGeneration = null,
    checking = false;
  const stage = (name, state) => {
    const node = byId('chain-' + name);
    node.dataset.state = state;
    node.textContent = labels[state] ?? labels.unknownStage;
  };
  const resetChain = () => {
    for (const name of ['source', 'detection', 'socket', 'applied', 'build'])
      stage(name, 'unknownStage');
  };
  async function hmrObservation(signal) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      let timer;
      const finish = (value) => {
        clearTimeout(timer);
        removeEventListener('message', receive);
        signal.removeEventListener('abort', cancelled);
        resolve(value);
      };
      const cancelled = () => finish(null);
      const uuid =
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
      const receive = (event) => {
        if (
          event.origin !== location.origin ||
          event.source !== frame.contentWindow ||
          event.data?.type !== 'mergeron-preview:observation' ||
          event.data.id !== id
        )
          return;
        const value = event.data.observation;
        if (
          !value ||
          value.adapter !== 'vite' ||
          !['connected', 'bypassed', 'unavailable'].includes(value.websocket) ||
          !['idle', 'updating', 'applied', 'error', 'reloading'].includes(
            value.phase,
          )
        )
          return;
        finish({
          adapter: 'vite',
          detectedGeneration:
            typeof value.detectedGeneration === 'string' &&
            uuid.test(value.detectedGeneration)
              ? value.detectedGeneration
              : null,
          socketGeneration:
            typeof value.socketGeneration === 'string' &&
            uuid.test(value.socketGeneration)
              ? value.socketGeneration
              : null,
          watching: value.watching === true,
          websocket: value.websocket,
          phase: value.phase,
          updates:
            Number.isSafeInteger(value.updates) &&
            value.updates >= 0 &&
            value.updates <= 1000000
              ? value.updates
              : 0,
          appliedAt:
            Number.isSafeInteger(value.appliedAt) && value.appliedAt > 0
              ? value.appliedAt
              : null,
        });
      };
      addEventListener('message', receive);
      signal.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(() => finish(null), 2500);
      if (signal.aborted) return cancelled();
      frame.contentWindow.postMessage(
        { type: 'mergeron-preview:inspect', id },
        location.origin,
      );
    });
  }
  const canonical = (sheet) =>
    Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
  const digest = async (text) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
      ),
      (v) => v.toString(16).padStart(2, '0'),
    ).join('');
  async function boundedText(response) {
    if ([401, 403].includes(response.status)) throw Error('PREVIEW_ACCESS');
    if (!response.ok || !response.body) throw Error();
    const reader = response.body.getReader();
    let size = 0,
      result = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 2 * 1024 ** 2) throw Error();
        result += decoder.decode(item.value, { stream: true });
      }
      return result + decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async function inspect() {
    if (checking) return;
    checking = true;
    const output = byId('result');
    output.textContent = labels.checking;
    output.dataset.state = 'checking';
    byId('observations').textContent = '';
    resetChain();
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), 8000);
    const fetchOptions = {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: abort.signal,
    };
    try {
      const evidence = JSON.parse(
        await boundedText(
          await fetch('/.__mergeron_preview/receipt', fetchOptions),
        ),
      );
      const receipt = evidence.receipt;
      byId('receipt').textContent = JSON.stringify(receipt, null, 2);
      if (!receipt || !evidence.synchronized) {
        stage('source', 'failed');
        output.dataset.state = 'source_unverified';
        output.textContent = labels.sourceFailed;
        return;
      }
      stage('source', 'passed');
      if (loadedGeneration === null) loadedGeneration = receipt.generation;
      const doc = frame.contentDocument;
      if (
        !doc ||
        !doc.documentElement ||
        doc.location.origin !== location.origin ||
        doc.location.pathname.startsWith('/.__mergeron_preview/')
      )
        throw Error('PREVIEW_FRAME');
      const hmr = await hmrObservation(abort.signal);
      if (hmr) {
        stage(
          'detection',
          hmr.watching && hmr.detectedGeneration === receipt.generation
            ? 'passed'
            : 'pendingStage',
        );
        stage(
          'socket',
          hmr.websocket === 'connected' &&
            hmr.socketGeneration === receipt.generation
            ? 'passed'
            : hmr.websocket === 'connected'
              ? 'pendingStage'
              : 'failed',
        );
        stage(
          'build',
          hmr.phase === 'error'
            ? 'failed'
            : hmr.phase === 'updating' || hmr.phase === 'reloading'
              ? 'pendingStage'
              : hmr.updates > 0
                ? 'passed'
                : 'idleStage',
        );
      }
      const html = doc
        .querySelector('meta[name="mergeron-preview-generation"]')
        ?.content?.trim();
      const css = frame.contentWindow
        .getComputedStyle(doc.documentElement)
        .getPropertyValue('--mergeron-preview-generation')
        .trim()
        .replace(/^['"]|['"]$/g, '');
      let state =
        !html || !css
          ? 'unknown'
          : html === receipt.generation && css === receipt.generation
            ? 'current'
            : 'stale';
      if (hmr?.phase === 'error') state = 'buildError';
      else if (hmr?.phase === 'updating') state = 'compiling';
      const details = [];
      if (loadedGeneration !== receipt.generation) details.push(labels.older);
      const links = Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'));
      let limited =
          links.length > 24 || doc.querySelectorAll('style').length > 0,
        compared = 0;
      const assets = [];
      for (const link of links.slice(0, 24)) {
        try {
          const url = new URL(link.href);
          if (
            url.origin !== location.origin ||
            url.href.length > 4096 ||
            !link.sheet ||
            link.disabled
          )
            throw Error();
          const loaded = canonical(link.sheet);
          if (loaded.length > 2 * 1024 ** 2 || /@import\b/.test(loaded))
            throw Error();
          const reply = await fetch(url.href, {
            ...fetchOptions,
            headers: { Accept: 'text/css' },
          });
          if (
            !/^text\/css(?:;|$)/i.test(reply.headers.get('content-type') || '')
          )
            throw Error();
          const fresh = await boundedText(reply);
          const parsed = new CSSStyleSheet();
          parsed.replaceSync(fresh);
          if (/@import\b/.test(fresh)) throw Error();
          const loadedHash = await digest(loaded),
            serverHash = await digest(canonical(parsed));
          assets.push({
            path: url.pathname.slice(0, 256),
            loadedHash,
            serverHash,
          });
          compared++;
          if (
            loadedHash !== serverHash &&
            !['buildError', 'compiling'].includes(state)
          )
            state = 'cssStale';
        } catch {
          limited = true;
        }
      }
      if (compared && state !== 'cssStale') details.push(labels.cssCurrent);
      if (limited || !compared) details.push(labels.limited);
      const selector = byId('selector').value.trim(),
        property = byId('property').value.trim(),
        expected = byId('expected').value;
      let style = null;
      if (selector && property) {
        try {
          const element = doc.querySelector(selector);
          const actual = element
            ? frame.contentWindow
                .getComputedStyle(element)
                .getPropertyValue(property)
                .trim()
            : null;
          style = { property, expected, actual, matches: actual === expected };
        } catch {
          style = { matches: false };
        }
        details.push(style.matches ? labels.stylePassed : labels.styleFailed);
        stage('applied', style.matches ? 'passed' : 'failed');
        if (!style.matches && state === 'current') state = 'styleMismatch';
      }
      if (
        hmr?.phase === 'applied' &&
        hmr.updates > 0 &&
        hmr.watching &&
        hmr.detectedGeneration === receipt.generation &&
        hmr.websocket === 'connected' &&
        hmr.socketGeneration === receipt.generation &&
        css === receipt.generation &&
        style?.matches === true &&
        compared > 0 &&
        !limited &&
        assets.every((asset) => asset.loadedHash === asset.serverHash)
      )
        state = html === receipt.generation ? 'current' : 'hmrApplied';
      const observation = {
        generation: receipt.generation,
        pageOpenedGeneration: loadedGeneration,
        htmlGeneration: html || null,
        cssGeneration: css || null,
        state,
        checkedAt: new Date().toISOString(),
        assets,
        limited,
        style,
        hmr,
      };
      const latest = JSON.parse(
        await boundedText(
          await fetch('/.__mergeron_preview/receipt', fetchOptions),
        ),
      );
      if (
        !latest.synchronized ||
        latest.receipt?.generation !== receipt.generation ||
        doc !== frame.contentDocument
      ) {
        stage('source', 'failed');
        output.dataset.state = 'source_unverified';
        output.textContent = labels.sourceFailed;
        return;
      }
      byId('observations').textContent = JSON.stringify(observation, null, 2);
      output.dataset.state = state;
      output.textContent = labels[state] + '\n' + details.join('\n');
    } catch (error) {
      resetChain();
      const state =
        error.message === 'PREVIEW_ACCESS'
          ? 'accessExpired'
          : error.message === 'PREVIEW_FRAME'
            ? 'frameUnavailable'
            : 'unavailable';
      output.dataset.state = state;
      output.textContent = labels[state];
    } finally {
      clearTimeout(timer);
      checking = false;
    }
  }
  frame.addEventListener('load', () => {
    loadedGeneration = null;
    void inspect();
  });
  byId('check').onclick = () => void inspect();
  byId('reload').onclick = () => {
    loadedGeneration = null;
    frame.src = path;
  };
  let monitor, deadline;
  const stop = () => {
    clearInterval(monitor);
    monitor = null;
    byId('monitor').textContent = labels.monitor;
  };
  byId('monitor').onclick = () => {
    if (monitor) return stop();
    deadline = Date.now() + 30000;
    byId('monitor').textContent = labels.monitoring;
    monitor = setInterval(() => {
      if (Date.now() >= deadline) stop();
      else void inspect();
    }, 3000);
    void inspect();
  };
  addEventListener('pagehide', stop, { once: true });
  resetChain();
  frame.src = path;
}
function verificationPage(nonce) {
  return (
    '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Preview</title>' +
    '<style nonce="' +
    nonce +
    '">body{font:14px system-ui;margin:16px;color:#17202a;background:#f8fafc}h1{font-size:20px}button,input{font:inherit;padding:8px;margin:4px 8px 4px 0}label{display:inline-block}input{max-width:85vw}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:white;border:1px solid #ccd5df;max-height:360px;overflow:auto}iframe{width:100%;height:60vh;border:1px solid #ccd5df}summary,button{cursor:pointer}</style>' +
    '<h1 data-label="title"></h1><p data-label="help"></p><button id="check" data-label="check"></button><button id="reload" data-label="reload"></button>' +
    '<details><summary data-label="expected"></summary><label><span data-label="selector"></span><br><input id="selector" placeholder="#example"></label><label><span data-label="property"></span><br><input id="property" placeholder="width"></label><label><span data-label="value"></span><br><input id="expected" placeholder="32px"></label></details>' +
    '<section aria-labelledby="chain-title"><h2 id="chain-title" data-label="chain"></h2><p data-label="monitorHelp"></p><p><a href="/.__mergeron_preview/vite-plugin.mjs" download="preview-vite-plugin.mjs" data-label="downloadAdapter"></a></p><button id="monitor" data-label="monitor"></button><dl>' +
    ['source', 'detection', 'socket', 'applied', 'build']
      .map(
        (name) =>
          '<dt data-label="' +
          name +
          '"></dt><dd id="chain-' +
          name +
          '"></dd>',
      )
      .join('') +
    '</dl></section>' +
    '<pre id="result" role="status"></pre><details><summary data-label="details"></summary><pre id="observations"></pre></details><p data-label="buildNote"></p><details><summary>Reçu / Receipt</summary><pre id="receipt"></pre></details><iframe id="application" title="Application preview"></iframe>' +
    '<script nonce="' +
    nonce +
    '">(' +
    verificationBrowser.toString() +
    ')();</script></html>'
  );
}
module.exports = { verificationPage, verificationBrowser };
