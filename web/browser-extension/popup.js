import { extension } from './browser-api.js';
const status = document.querySelector('#status');
async function call(action, payload = {}) {
  const result = await extension.runtime.sendMessage({
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
  extension.runtime.openOptionsPage();
document.querySelector('#share').onclick = async () => {
  try {
    const [tab] = await extension.tabs.query({
      active: true,
      currentWindow: true,
    });
    await call('share', {
      id: document.querySelector('#session').value,
      tabId: tab.id,
    });
    status.textContent =
      'Cet onglet est partagé. Mergeron lui-même est limité aux annotations ; ailleurs, toute action de l’agent doit être confirmée.';
  } catch {
    status.textContent =
      'Partage impossible. Rechargez la page HTTPS et Mergeron après une mise à jour de l’extension, puis utilisez cette icône.';
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
  } catch (error) {
    status.textContent =
      error.message === 'UPDATE_MERGERON_FOR_ANNOTATIONS'
        ? 'Cette instance Mergeron doit être mise à jour pour recevoir les commentaires et images. Rechargez Mergeron après sa mise à jour, puis créez une nouvelle association.'
        : 'Gardez l’onglet partagé au premier plan. Terminez ou annulez l’annotation en cours avant de recommencer.';
  }
};
render().catch(() => {
  status.textContent =
    'Extension indisponible. Rechargez-la dans les réglages du navigateur.';
});
