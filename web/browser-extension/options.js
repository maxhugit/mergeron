import { instanceOrigin, CHANNEL } from './protocol.js';
import { extension } from './browser-api.js';
const field = document.querySelector('#origin'),
  status = document.querySelector('#status');
field.value = (await extension.storage.local.get('origin')).origin ?? '';
document
  .querySelector('#settings')
  .addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const origin = instanceOrigin(field.value);
      if (!(await extension.permissions.request({ origins: [origin + '/*'] })))
        throw Error('PERMISSION_DENIED');
      const result = await extension.runtime.sendMessage({
        channel: CHANNEL,
        action: 'configure',
        payload: { origin },
      });
      if (!result?.ok) throw Error('CONFIGURATION_FAILED');
      status.textContent =
        'Instance autorisée. Rechargez maintenant l’onglet Mergeron.';
    } catch {
      status.textContent =
        'Configuration impossible. Utilisez uniquement l’origine HTTPS de votre instance et autorisez la connexion.';
    }
  });
document.querySelector('#disconnect').addEventListener('click', async () => {
  await extension.runtime.sendMessage({
    channel: CHANNEL,
    action: 'configure',
    payload: {},
  });
  status.textContent = 'Instance déconnectée. Tous les partages sont révoqués.';
});
