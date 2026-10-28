import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { DEFAULT_AGENT_INSTRUCTIONS } from '../../../../src/settings/agent-instructions';
import { AgentInstructionsSettings } from './agent-instructions-settings';
import { catalogFixture, json } from './catalog/catalog.testing';

afterEach(cleanup);

test('shows the actual common policy and keeps the editor and save actions within desktop/mobile bounds', async () => {
  await i18nReady;
  const fixture = catalogFixture();
  await i18n.changeLanguage('fr');
  const key = 'general.agentInstructions';
  const setting = {
    key,
    value: DEFAULT_AGENT_INSTRUCTIONS,
    defaultValue: DEFAULT_AGENT_INSTRUCTIONS,
  };
  fixture.server.overrides.set(`GET /api/settings/${key}`, () => json(setting));
  fixture.server.overrides.set(`PATCH /api/settings/${key}`, async (request) =>
    json({
      ...setting,
      value: ((await request.json()) as { value: string }).value,
    }),
  );
  fixture.render(
    <main className="min-h-dvh w-full bg-background p-4 text-foreground sm:p-6">
      <AgentInstructionsSettings active />
    </main>,
  );
  try {
    const text = await screen.findByRole('textbox', {
      name: 'Texte des consignes communes',
    });
    expect(text).toHaveValue(DEFAULT_AGENT_INSTRUCTIONS);
    for (const width of [1440, 390]) {
      await page.viewport(width, 900);
      expect(text).toBeVisible();
      expect(text.getBoundingClientRect().height).toBeLessThanOrEqual(400);
      expect(
        screen.getByRole('heading', { name: 'Consignes communes aux agents' }),
      ).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      for (const element of document.querySelectorAll('textarea, button')) {
        const bounds = element.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(width);
      }
      await page.screenshot({
        path: `../../../.vitest-screenshots/agent-instructions-${width}.png`,
      });
    }
    fireEvent.change(text, {
      target: { value: 'Contrôler les deux formats et ouvrir les images.' },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Enregistrer les consignes communes',
      }),
    );
    await screen.findByText(/Consignes enregistrées/);
    expect(fixture.server.writes).toHaveLength(1);
  } finally {
    fixture.dispose();
  }
});
