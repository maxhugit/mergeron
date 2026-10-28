const status = document.querySelector('#status');
async function call(action, payload = {}) {
  const result = await chrome.runtime.sendMessage({
    channel: 'mergeron-local-browser-v1',
    action,
    payload,
  });
  if (result?.error) throw Error(result.error);
  return result;
}
async function render() {
  const { origin, sessions } = await call('popup');
  document.querySelector('#instance').textContent =
    origin ?? 'Aucune instance configurée';
  const connections = document.querySelector('#connections'),
    select = document.querySelector('#session');
  connections.replaceChildren();
  select.replaceChildren();
  for (const session of sessions) {
    if (!session.paired) {
      const card = document.createElement('article'),
        text = document.createElement('small'),
        approve = document.createElement('button');
      text.textContent = `Associer cet agent : ${session.threadId} · ${origin} · ${session.id.slice(0, 8)}`;
      approve.textContent = 'Confirmer l’appairage';
      approve.onclick = async () => {
        try {
          await call('approvePair', { id: session.id });
          await render();
        } catch {
          status.textContent = 'Appairage expiré.';
        }
      };
      card.append(text, approve);
      connections.append(card);
    } else {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = `${session.threadId} · ${session.shared ? 'partagé' : 'en pause'}`;
      select.append(option);
    }
  }
  document.querySelector('#share').disabled = !select.options.length;
  document.querySelector('#point').disabled = !select.options.length;
}
document.querySelector('#options').onclick = () =>
  chrome.runtime.openOptionsPage();
document.querySelector('#share').onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    await call('share', {
      id: document.querySelector('#session').value,
      tabId: tab.id,
    });
    status.textContent =
      'Cet onglet est partagé. Toute action de l’agent devra être confirmée dans Mergeron.';
  } catch {
    status.textContent =
      'Partage impossible. Ouvrez une page HTTPS hors de Mergeron, puis utilisez cette icône.';
  }
};
document.querySelector('#pause').onclick = async () => {
  await call('pause');
  await render();
  status.textContent = 'Tous les partages sont suspendus.';
};
document.querySelector('#point').onclick = async () => {
  try {
    await call('point', { id: document.querySelector('#session').value });
    window.close();
  } catch {
    status.textContent = 'Reprenez d’abord le partage de cet onglet.';
  }
};
render().catch(() => {
  status.textContent =
    'Extension indisponible. Rechargez-la dans les réglages du navigateur.';
});
