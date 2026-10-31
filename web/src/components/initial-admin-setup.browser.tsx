import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { InitialSetupGate } from './initial-admin-setup';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});
test.each([390, 1280])(
  'first administrator fits %ipx and only submits after explicit validation',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status'))
        return {
          ok: true,
          json: async () => ({
            required: true,
            authorized: false,
            containerName: 'mergeron-dev-ui',
          }),
        };
      if (url.endsWith('/verify'))
        return {
          ok: true,
          json: async () => ({
            authorized: true,
            csrfToken: 'isolated-fixture-csrf',
          }),
        };
      expect(JSON.parse(init!.body as string).csrfToken).toBe(
        'isolated-fixture-csrf',
      );
      return { ok: true, json: async () => ({ completed: true }) };
    });
    vi.stubGlobal('fetch', fetch);
    render(
      <InitialSetupGate>
        <h1>Connexion normale</h1>
      </InitialSetupGate>,
    );
    const code = await screen.findByLabelText('Code d’activation');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.body.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../.vitest-screenshots/initial-admin-code-${width}.png`,
    });
    fireEvent.change(code, { target: { value: 'isolated-fixture-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Valider le code' }));
    for (const [label, value] of [
      ['Prénom', 'Premier'],
      ['Nom', 'Administrateur'],
      ['Adresse e-mail', 'initial@example.test'],
      ['Identifiant', 'initial.admin'],
      ['Mot de passe', 'fixture-password-only'],
      ['Confirmer le mot de passe', 'fixture-password-only'],
    ])
      fireEvent.change(await screen.findByLabelText(label), {
        target: { value },
      });
    expect(document.body.scrollWidth).toBeLessThanOrEqual(width);
    expect(fetch).toHaveBeenCalledTimes(2);
    await page.screenshot({
      path: `../../.vitest-screenshots/initial-admin-form-${width}.png`,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Créer l’administrateur' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'La première configuration',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(screen.getByText('Connexion normale')).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);
