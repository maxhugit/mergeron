'use strict';
const accessCodes = Object.freeze({
  session_required: 401,
  session_expired: 401,
  permission_denied: 403,
  configuration_changed: 409,
  environment_unavailable: 503,
  upstream_unavailable: 502,
  origin_denied: 403,
  invalid_request: 400,
  unavailable: 503,
});
class PreviewAccessError extends Error {
  constructor(code) {
    super(
      'PREVIEW_' +
        (Object.hasOwn(accessCodes, code) ? code : 'unavailable').toUpperCase(),
    );
    this.reason = Object.hasOwn(accessCodes, code) ? code : 'unavailable';
  }
}
function safeMergeronUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
function accessBrowser(options) {
  const fr = navigator.language.startsWith('fr');
  const labels = fr
    ? {
        title: 'Accès à la preview',
        mergeron: 'Accès Mergeron à la preview',
        site: 'Connexion propre au site',
        independent:
          'La connexion membre ou administrateur du site est indépendante. Cette page ne la déconnecte pas et ne modifie pas ses droits.',
        reopen: 'Rouvrir depuis Mergeron',
        help: 'Revenez au projet dans Mergeron, puis ouvrez à nouveau la preview.',
        checking: 'Vérification de l’autorisation Mergeron…',
        session_required:
          'Accès Mergeron absent, invalide ou expiré. Rouvrez la preview depuis Mergeron.',
        session_expired:
          'Votre autorisation Mergeron a expiré. Rouvrez la preview depuis Mergeron.',
        permission_denied:
          'Mergeron refuse cet accès. Vérifiez votre connexion et vos droits sur le projet.',
        configuration_changed:
          'La source ou la configuration de la preview a changé. Rouvrez-la depuis Mergeron.',
        environment_unavailable:
          'L’environnement de preview est indisponible ou arrêté. Vérifiez son état dans Mergeron.',
        upstream_unavailable:
          'Mergeron ne peut pas joindre le serveur du site. Consultez l’état et les journaux de la preview.',
        origin_denied:
          'Mergeron refuse l’origine de cette requête. Rouvrez la preview depuis son lien Mergeron.',
        invalid_request:
          'Le lien ou la requête de preview est invalide. Rouvrez depuis Mergeron.',
        unavailable:
          'La vérification de l’accès Mergeron est indisponible. Réessayez depuis Mergeron.',
      }
    : {
        title: 'Preview access',
        mergeron: 'Mergeron access to the preview',
        site: 'The site’s own login session',
        independent:
          'The site member or administrator session is independent. This page does not sign it out or change its permissions.',
        reopen: 'Reopen from Mergeron',
        help: 'Return to the project in Mergeron and open its preview again.',
        checking: 'Checking Mergeron authorization…',
        session_required:
          'Mergeron access is missing, invalid or expired. Reopen the preview from Mergeron.',
        session_expired:
          'Your Mergeron authorization has expired. Reopen the preview from Mergeron.',
        permission_denied:
          'Mergeron denied access. Check your login and project permissions.',
        configuration_changed:
          'The preview source or configuration changed. Reopen it from Mergeron.',
        environment_unavailable:
          'The preview environment is unavailable or stopped. Check its state in Mergeron.',
        upstream_unavailable:
          'Mergeron cannot reach the site server. Check the preview state and logs.',
        origin_denied:
          'Mergeron rejected the request origin. Reopen the preview using its Mergeron link.',
        invalid_request:
          'The preview link or request is invalid. Reopen from Mergeron.',
        unavailable:
          'Mergeron access verification is unavailable. Retry from Mergeron.',
      };
  document.documentElement.lang = fr ? 'fr' : 'en';
  document.title = labels.title;
  for (const node of document.querySelectorAll('[data-label]'))
    node.textContent = labels[node.dataset.label];
  const status = document.getElementById('access-status');
  const show = (reason) => {
    status.textContent = labels[reason] ?? labels.unavailable;
    status.dataset.reason = Object.hasOwn(labels, reason)
      ? reason
      : 'unavailable';
  };
  show(options.reason);
  if (!options.bootstrap) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('mergeron-preview'),
    path = params.get('path') || '/';
  const safe =
    path.startsWith('/') && !path.startsWith('//') && !/[\\\r\n#]/.test(path);
  history.replaceState(null, '', safe ? path : '/');
  if (token && !/^[a-zA-Z0-9_-]{43}$/.test(token))
    return show('invalid_request');
  if (token) {
    status.textContent = labels.checking;
    fetch('/.__mergeron_preview/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(8000),
    })
      .then(async (response) => {
        if (response.ok) return location.reload();
        const data = await response.json().catch(() => null);
        show(data?.code);
      })
      .catch(() => show('unavailable'));
  }
}
function accessPage(
  nonce,
  { reason = 'session_required', bootstrap = false, mergeronUrl } = {},
) {
  const link = safeMergeronUrl(mergeronUrl);
  return (
    '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Preview access</title>' +
    '<style nonce="' +
    nonce +
    '">body{font:16px system-ui;max-width:760px;margin:32px auto;padding:0 16px;color:#17202a;background:#f8fafc}section{border:1px solid #ccd5df;background:white;padding:16px;margin:16px 0}h1{font-size:24px}h2{font-size:18px}a{display:inline-block;padding:10px 0}</style>' +
    '<h1 data-label="title"></h1><section><h2 data-label="mergeron"></h2><p id="access-status" role="status"></p><p data-label="help"></p>' +
    (link
      ? '<a data-label="reopen" href="' +
        link
          .replaceAll('&', '&amp;')
          .replaceAll('"', '&quot;')
          .replaceAll('<', '&lt;') +
        '" rel="noopener noreferrer"></a>'
      : '') +
    '</section><section><h2 data-label="site"></h2><p data-label="independent"></p></section><script nonce="' +
    nonce +
    '">(' +
    accessBrowser.toString() +
    ')(' +
    JSON.stringify({
      reason: Object.hasOwn(accessCodes, reason) ? reason : 'unavailable',
      bootstrap,
    }).replaceAll('<', '\\u003c') +
    ');</script></html>'
  );
}
module.exports = {
  PreviewAccessError,
  accessCodes,
  accessPage,
  safeMergeronUrl,
};
