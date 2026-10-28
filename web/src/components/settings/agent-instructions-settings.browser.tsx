import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { AgentInstructionsSettings } from './agent-instructions-settings';
import { catalogFixture, json } from './catalog/catalog.testing';

afterEach(cleanup);

// A representative administrator-saved text: frontend builds intentionally
// contain only web/, so browser fixtures must not import backend sources.
const DEFAULT_AGENT_INSTRUCTIONS = `Vérification visuelle des interfaces web

Lorsque vous créez ou modifiez une interface web, effectuez automatiquement une vérification visuelle avant de déclarer le travail terminé. Une simple question, une revue sans modification ou un travail en mode plan n'autorise pas à modifier ou démarrer des services.

Utilisez mergeron-visual-check --help dans l'environnement des agents. Pour le vrai site, indiquez son URL et un sélecteur réel de la fonctionnalité attendue. Si nécessaire, fournissez sa commande de démarrage avec --start. Attendez une réponse du serveur, puis vérifiez desktop.png, mobile.png et report.json dans artifacts/visual-check. Le test autonome --smoke ne remplace pas celui du vrai site.

Ouvrez réellement les captures ordinateur ET mobile avec un outil de consultation d'images. Examinez la lisibilité, la disposition, les débordements, les superpositions, les éléments coupés et les contrôles essentiels. Corrigez les défauts dans le périmètre demandé, puis relancez les tests et examinez les nouvelles captures. La création des PNG ne démontre pas à elle seule que le rendu a été examiné.

Respectez les permissions, le sandbox, TLS et le proxy existants. Testez uniquement les sites de travail de confiance. Si le serveur tourne dans un autre conteneur, utilisez son adresse de service autorisée, pas localhost. Ne publiez pas de port et ne transmettez pas les captures confidentielles sans autorisation.

Si le serveur, les droits, un outil de consultation d'images ou le navigateur manquent, expliquez ce qui bloque et ce qui n'a pas pu être vérifié. Ne contournez pas les protections. Ne prétendez jamais avoir exécuté un test ou examiné une capture sans l'avoir fait. Dans le résultat final, distinguez les vérifications automatiques, l'examen visuel et les limites ; indiquez où trouver les captures.`;

test('shows the saved common policy and keeps the editor and save actions within desktop/mobile bounds', async () => {
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
