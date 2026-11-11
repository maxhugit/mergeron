/** Self-contained page: same independent journal as the dialog, no application bundle/CDN. */
export const monitorPage = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Suivi de la mise à jour · Mergeron</title><style>
:root{color-scheme:light dark;--bg:light-dark(#f8fafc,#171e29);--surface:light-dark(#fff,#232d3d);--text:light-dark(#1d2939,#edf2f7);--muted:light-dark(#59687d,#afbdcf);--line:light-dark(#dce3ec,#3d4a5d);--soft:light-dark(#f0f5f8,#29384a);--accent:light-dark(#25697c,#8ecbd7);--warn:light-dark(#9c510c,#f3bb77)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif;padding:32px 16px}main{max-width:780px;margin:auto;background:var(--surface);border:1px solid var(--line);border-radius:18px;overflow:hidden}header,footer{padding:18px 24px}header{border-bottom:1px solid var(--line)}h1,h2,h3,p{margin:0;font-weight:400}h1,h3{font-size:14px;font-weight:500}header p,.muted{color:var(--muted);font-size:12px}#content{padding:24px;display:flex;flex-direction:column;gap:22px}.statusrow{display:flex;align-items:start;justify-content:space-between;gap:16px;flex-wrap:wrap}h2{font-size:22px;font-weight:500}#connection{font-size:12px;color:var(--accent)}#connection[data-error=true]{color:var(--warn)}#observed{font-size:12px;color:var(--muted);margin-top:5px}#track{display:flex;gap:4px;margin-bottom:10px}#track span{flex:1;height:6px;border-radius:8px;background:var(--line)}#track .done{background:var(--accent)}#track .current{background:color-mix(in srgb,var(--accent) 65%,var(--surface))}#steps{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;list-style:none;padding:0;margin:0 0 10px;font-size:12px;color:var(--muted)}#steps li[aria-current]{font-weight:500;color:var(--text)}#steps span{display:block;margin-bottom:5px}#notice{background:var(--soft);border-radius:10px;padding:13px 14px;font-size:13px}#notice[data-error=true]{color:var(--warn)}#events{list-style:none;margin:10px 0 0;padding:0;max-height:260px;overflow:auto}#events li{display:grid;grid-template-columns:72px minmax(0,1fr);gap:12px;border-top:1px solid var(--line);padding:9px 0;overflow-wrap:anywhere}time{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}details{border-top:1px solid var(--line);padding-top:12px;font-size:12px}details p{margin-top:10px;color:var(--muted)}summary{cursor:pointer}footer{border-top:1px solid var(--line)}a{color:var(--accent);font-size:13px}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}[hidden]{display:none!important}@media(max-width:560px){body{padding:12px 8px}header,footer{padding:16px}#content{padding:18px 16px}h2{font-size:20px}#steps{grid-template-columns:repeat(3,minmax(0,1fr))}a,summary{display:inline-block;min-height:44px;padding:10px 0}}
</style></head><body><main><header><h1 id="title">Suivi de la mise à jour</h1><p id="description">Mergeron · Suivi indépendant</p></header><div id="content"><section class="statusrow" aria-live="polite"><div><h2 id="state">Connexion au suivi…</h2><p id="observed"></p></div><p id="connection"></p></section><section id="progress" hidden><div id="track" role="progressbar" aria-valuemin="0"></div><ol id="steps"></ol><p id="count" class="muted"></p></section><p id="notice" role="status"></p><section><h3 id="journal-title">Journal de l’opération</h3><ol id="events" role="log" aria-live="polite" aria-relevant="additions"></ol></section><details><summary id="details-title">Détails techniques</summary><p id="details-text">Les détails techniques sont accessibles depuis Mergeron avec une session administrateur vérifiée. Ce suivi ne publie aucune donnée sensible.</p></details></div><footer><a href="/" id="return">Revenir à Mergeron</a></footer></main><script src="/_mergeron-update/monitor.js" defer></script></body></html>`;

function monitorClient() {
  const fr = {
    title: 'Suivi de la mise à jour',
    description: 'Mergeron · Suivi indépendant',
    connecting: 'Connexion au suivi…',
    connected: 'Suivi connecté',
    observed: 'Dernière donnée reçue à ',
    waiting: 'En attente du démarrage de la nouvelle opération…',
    auth: 'Ouvrez le suivi depuis une session administrateur de Mergeron pour consulter les étapes.',
    lost: 'Connexion au suivi interrompue. Dernière étape connue conservée ; reconnexion automatique.',
    changed:
      'Une autre opération est courante. Ce journal conservé est incomplet ; revenez à Mergeron pour ouvrir le nouveau suivi.',
    normal:
      'La mise à jour continue indépendamment de cette page. Les interruptions de Mergeron pendant le redémarrage sont prévues.',
    success: 'Mise à jour réussie',
    checkpoint: 'Sauvegarde créée',
    rolledBack: 'Version précédente restaurée',
    recoveryRequired: 'Intervention nécessaire',
    cancelled: 'Opération interrompue sans changement de version',
    noTime: 'Avancement par étapes, sans estimation du temps restant.',
    step: 'Étape',
    of: 'sur',
    journal: 'Journal de l’opération',
    details: 'Détails techniques',
    back: 'Revenir à Mergeron',
    detailsText:
      'Les détails techniques sont accessibles depuis Mergeron avec une session administrateur vérifiée. Ce suivi ne publie aucune donnée sensible.',
    applicationComplete:
      'Application mise à jour — vérification du Manager à suivre',
    unknown: 'Étape non reconnue',
    phases: {
      preparing: 'Préparation',
      stopping: 'Arrêt des services',
      backingUp: 'Sauvegarde',
      restoring: 'Restauration des données',
      replacing: 'Installation des services',
      checkingHealth: 'Vérification des services',
      committing: 'Finalisation',
      rollingBack: 'Retour arrière',
      recoveryRequired: 'Intervention nécessaire',
      managerPending: 'Préparation du Manager',
      managerReplacing: 'Remplacement du Manager',
      managerChecking: 'Vérification du Manager',
      managerRolledBack: 'Ancien Manager restauré',
      complete: 'Terminé',
    },
  };
  const en = {
    title: 'Update progress',
    description: 'Mergeron · Independent monitoring',
    connecting: 'Connecting to monitoring…',
    connected: 'Monitoring connected',
    observed: 'Last data received at ',
    waiting: 'Waiting for the new operation to start…',
    auth: 'Open monitoring from a Mergeron administrator session to view progress.',
    lost: 'Monitoring connection interrupted. Last known step retained; reconnecting automatically.',
    changed:
      'Another operation is current. This retained journal is incomplete; return to Mergeron to open its monitor.',
    normal:
      'The update continues independently of this page. Mergeron interruptions during restart are expected.',
    success: 'Update successful',
    checkpoint: 'Backup created',
    rolledBack: 'Previous version restored',
    recoveryRequired: 'Intervention required',
    cancelled: 'Operation interrupted without a version change',
    noTime: 'Progress by stages, without an estimated time remaining.',
    step: 'Step',
    of: 'of',
    journal: 'Operation journal',
    details: 'Technical details',
    back: 'Return to Mergeron',
    detailsText:
      'Technical details are available in Mergeron with a verified administrator session. This monitor publishes no sensitive data.',
    applicationComplete: 'Application updated — Manager verification follows',
    unknown: 'Unrecognized step',
    phases: {
      preparing: 'Preparation',
      stopping: 'Stopping services',
      backingUp: 'Backup',
      restoring: 'Restoring data',
      replacing: 'Installing services',
      checkingHealth: 'Checking services',
      committing: 'Finalizing',
      rollingBack: 'Rolling back',
      recoveryRequired: 'Intervention required',
      managerPending: 'Preparing Manager',
      managerReplacing: 'Replacing Manager',
      managerChecking: 'Checking Manager',
      managerRolledBack: 'Previous Manager restored',
      complete: 'Complete',
    },
  };
  const params = new URLSearchParams(location.search);
  const language = (
    params.get('lang') ||
    navigator.language ||
    'fr'
  ).startsWith('fr')
    ? 'fr'
    : 'en';
  const t = language === 'fr' ? fr : en;
  document.documentElement.lang = language;
  const $ = (id) => document.getElementById(id);
  for (const [id, key] of Object.entries({
    title: 'title',
    description: 'description',
    state: 'connecting',
    'journal-title': 'journal',
    'details-title': 'details',
    'details-text': 'detailsText',
    return: 'back',
  }))
    $(id).textContent = t[key];
  const phaseLabel = (phase) => t.phases[phase] || t.unknown;
  let id = params.get('operation'),
    failures = 0,
    timer,
    controller,
    stopped = false,
    snapshot = null;
  let generation = 0;
  const excluded = params.get('exclude');
  const word = (value) =>
    typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
  const timestamp = (value) =>
    typeof value === 'string' &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value));
  function render(data) {
    const op = data.operation;
    if (!op) {
      $('state').textContent = t.waiting;
      return;
    }
    snapshot = data;
    const terminal = op.status !== 'running';
    $('state').textContent = terminal
      ? op.status === 'succeeded'
        ? op.checkpoint
          ? t.checkpoint
          : t.success
        : t[op.status]
      : phaseLabel(op.phase);
    $('observed').textContent =
      t.observed + new Date(data.observedAt).toLocaleTimeString(language);
    $('notice').textContent = terminal ? $('state').textContent : t.normal;
    $('notice').dataset.error = String(
      op.status === 'rolledBack' || op.status === 'recoveryRequired',
    );
    const knownStages = [
      'preparing',
      'stopping',
      'backingUp',
      'replacing',
      'checkingHealth',
      'committing',
    ];
    if (
      op.phase.startsWith('manager') ||
      op.events.some((event) => event.phase.startsWith('manager'))
    )
      knownStages.push('managerPending', 'managerReplacing', 'managerChecking');
    const stages =
      Array.isArray(op.stages) &&
      op.stages.length <= 12 &&
      op.stages.every(word)
        ? op.stages
        : knownStages;
    const index = stages.indexOf(op.phase),
      complete = op.status === 'succeeded';
    $('progress').hidden = false;
    $('track').setAttribute('aria-label', t.title);
    $('track').setAttribute('aria-valuemax', String(stages.length));
    $('track').setAttribute('aria-valuetext', $('state').textContent);
    if (complete || index >= 0)
      $('track').setAttribute(
        'aria-valuenow',
        String(complete ? stages.length : index),
      );
    else $('track').removeAttribute('aria-valuenow');
    $('track').replaceChildren(
      ...stages.map((_, n) => {
        const bar = document.createElement('span');
        bar.className =
          complete || n < index
            ? 'done'
            : n === index && !terminal
              ? 'current'
              : '';
        return bar;
      }),
    );
    $('steps').replaceChildren(
      ...stages.map((phase, n) => {
        const li = document.createElement('li'),
          number = document.createElement('span');
        number.textContent = complete || n < index ? '✓' : String(n + 1);
        li.append(number, document.createTextNode(phaseLabel(phase)));
        if (n === index && !terminal) li.setAttribute('aria-current', 'step');
        return li;
      }),
    );
    $('count').textContent =
      (!terminal && index >= 0
        ? t.step + ' ' + (index + 1) + ' ' + t.of + ' ' + stages.length + ' · '
        : '') + t.noTime;
    // Do not replace the log on every identical poll: preserve scroll position and screen-reader context.
    const events = op.events.slice(-200);
    const signature = JSON.stringify(events);
    if ($('events').dataset.signature !== signature) {
      const log = $('events'),
        atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 4;
      const previousTop = log.scrollTop;
      log.replaceChildren(
        ...events.map((event, index) => {
          const li = document.createElement('li'),
            time = document.createElement('time');
          time.dateTime = event.at;
          time.textContent = new Date(event.at).toLocaleTimeString(language);
          const label = document.createElement('span');
          label.textContent =
            event.phase === 'complete' &&
            stages.includes('managerReplacing') &&
            (!terminal || index < events.length - 1)
              ? t.applicationComplete
              : phaseLabel(event.phase);
          li.append(time, label);
          return li;
        }),
      );
      log.dataset.signature = signature;
      log.scrollTop = atBottom ? log.scrollHeight : previousTop;
    }
  }
  async function poll() {
    if (stopped) return;
    const ticket = generation;
    controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/_mergeron-update/status', {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (stopped || ticket !== generation) return;
      if (response.status === 401) {
        $('connection').textContent = t.auth;
        $('connection').dataset.error = 'true';
        failures++;
        return;
      }
      if (
        !response.ok ||
        !response.headers.get('content-type')?.includes('application/json')
      )
        throw Error();
      const data = await response.json(),
        op = data?.operation;
      if (
        !timestamp(data?.observedAt) ||
        (op !== null &&
          (!op ||
            typeof op.id !== 'string' ||
            op.id.length > 128 ||
            !word(op.phase) ||
            ![
              'running',
              'succeeded',
              'rolledBack',
              'recoveryRequired',
              'cancelled',
            ].includes(op.status) ||
            !Array.isArray(op.events) ||
            !op.events.every(
              (event) =>
                event &&
                timestamp(event.at) &&
                word(event.phase) &&
                word(event.status),
            )))
      )
        throw Error();
      if (op?.id === excluded) {
        $('state').textContent = t.waiting;
        return;
      }
      if (op && id && id !== op.id) {
        $('connection').textContent = t.changed;
        $('connection').dataset.error = 'true';
        stopped = true;
        return;
      }
      if (!op && snapshot) throw Error();
      if (op) id = op.id;
      render(data);
      failures = 0;
      $('connection').textContent = t.connected;
      $('connection').dataset.error = 'false';
      if (op && op.status !== 'running') stopped = true;
    } catch {
      if (!stopped && ticket === generation) {
        failures++;
        $('connection').textContent = t.lost;
        $('connection').dataset.error = 'true';
        $('notice').textContent = t.lost;
        $('notice').dataset.error = 'true';
      }
    } finally {
      clearTimeout(deadline);
      if (!stopped && ticket === generation)
        timer = setTimeout(
          poll,
          Math.min(1000 * 2 ** Math.min(failures, 3), 8000),
        );
    }
  }
  window.addEventListener('pagehide', () => {
    stopped = true;
    generation++;
    clearTimeout(timer);
    controller?.abort();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      stopped = false;
      void poll();
    }
  });
  void poll();
}
export const monitorScript = `(${monitorClient.toString()})();`;
