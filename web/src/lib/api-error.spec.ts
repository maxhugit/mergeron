import { expect, it } from 'vitest';
import i18n, { i18nReady } from '@/i18n';
import { getApiErrorMessage } from './api-error';
it('explains a Codex timeout without claiming an operation was never accepted', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  const message = getApiErrorMessage({
    errorCode: 'codex.request_timeout',
    params: { method: 'app/list' },
  });
  expect(message).toContain('app/list');
  expect(message).toContain('Vérifiez l’état du fil');
  expect(message).not.toContain('Internal server error');
});
