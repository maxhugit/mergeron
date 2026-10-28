import { extension } from './browser-api.js';
import { CHANNEL } from './protocol.js';
import { markCapture } from './annotation-image.js';

const draftId = location.hash.slice(1);
const status = document.querySelector('#status');
const submit = document.querySelector('#submit');
let image;
async function call(action, payload = {}) {
  const result = await extension.runtime.sendMessage({
    channel: CHANNEL,
    action,
    payload: { ...payload, draftId },
  });
  if (!result || result.error) throw Error('ANNOTATION_UNAVAILABLE');
  return result;
}
try {
  const draft = await call('annotationOpen');
  document.querySelector('#target').textContent =
    `Agent : ${draft.threadId} · ${draft.selection.url} · ${draft.selection.text}`;
  image = await markCapture(draft.image, draft.geometry);
  const preview = document.querySelector('#preview');
  preview.src = image;
  preview.hidden = false;
  submit.disabled = false;
  status.textContent = 'Rien n’est transmis avant votre validation.';
} catch {
  status.textContent =
    'Capture indisponible ou expirée. Revenez sur la page et relancez le pointeur ; aucune image n’a été transmise.';
}
document
  .querySelector('#annotation-form')
  .addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!image || submit.disabled) return;
    submit.disabled = true;
    try {
      await call('annotationSubmit', { image, comment: '' });
      status.textContent =
        'Capture ajoutée à la zone de saisie Mergeron. Complétez votre message puis envoyez-le depuis la conversation.';
      window.close();
    } catch {
      // No automatic retransmission after uncertainty; keep the private draft visible.
      status.textContent =
        'Ajout non confirmé ou partage interrompu. Vérifiez la zone de saisie Mergeron avant de recommencer.';
    }
  });
document.querySelector('#cancel').addEventListener('click', async () => {
  await call('annotationCancel').catch(() => {});
  image = undefined;
  document.querySelector('#preview').removeAttribute('src');
  window.close();
});
