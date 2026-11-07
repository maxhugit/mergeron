/** Real Codex settings with synthetic HTTP data; no live account, restart or install. */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { CodexSettings } from './codex-settings';
import { catalogFixture, json } from './catalog/catalog.testing';
import { useAccountStore } from '@/stores/account-store';
import { FIELD_DEFS } from './codex-settings-defs';
import { accountReadAccountQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import { translationKey } from '@/locales/translation-key';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

vi.mock('@monaco-editor/react', async () => ({
  default: (await import('./catalog/catalog.testing')).TextEditor,
}));
// The integrations surface is unchanged and has its own complete browser suite.
vi.mock('@/components/integrations/integrations-panel', () => ({
  IntegrationsPanel: () => <section>Integrations</section>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAccountStore.getState().setAccount(null);
  document.documentElement.classList.remove('dark');
});
for (const width of [320, 390, 1100])
  test(`retains all fields and fixed panel regions at ${width}px`, async () => {
    await i18nReady;
    const fixture = catalogFixture();
    await i18n.changeLanguage('fr');
    document.documentElement.classList.add('dark');
    await page.viewport(width, 900);
    const account = {
      account: { type: 'apiKey' as const },
      requiresOpenaiAuth: true,
      provider: {
        ok: true,
        id: 'openai',
        name: 'OpenAI',
        baseUrlMasked: null,
        envKey: null,
        envPresent: null,
      },
    };
    fixture.queryClient.setQueryData(accountReadAccountQueryKey(), account);
    useAccountStore.getState().setAccount(account);
    const config = {
      ...Object.fromEntries(
        FIELD_DEFS.map((f) => [
          f.key,
          f.control === 'number' ? 16384 : (f.options?.[0] ?? 'alpha'),
        ]),
      ),
      profiles: { work: {} },
      profile: 'work',
    };
    fixture.server.overrides.set('GET /api/account', () => json(account));
    fixture.server.overrides.set('GET /api/codex/config', () =>
      json({ config, origins: {} }),
    );
    fixture.server.overrides.set('GET /api/models', () =>
      json({
        data: [
          {
            model: 'alpha',
            hidden: false,
            isDefault: true,
            serviceTiers: [{ id: 'default' }],
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
          },
        ],
        nextCursor: null,
      }),
    );
    fixture.server.overrides.set('GET /api/codex/status', () =>
      json({ connected: true }),
    );
    fixture.server.overrides.set(
      'GET /api/settings/general.agentInstructions',
      () =>
        json({
          value: 'Instructions de contrôle.\n'.repeat(30),
          defaultValue: 'Instructions par défaut',
        }),
    );
    fixture.server.overrides.set('GET /api/simple-chat/api-key', () =>
      json({ configured: true, managed: true }),
    );
    fixture.server.overrides.set('GET /api/simple-chat/settings', () =>
      json({ backend: 'codex', configured: true, audioBackend: 'codex' }),
    );
    fixture.server.overrides.set('GET /api/local-agents/configuration', () =>
      json({
        enabled: true,
        url: 'http://ollama:11434',
        models: 'example:local',
        context: 16384,
        metadataRestartRequired: true,
      }),
    );
    fixture.server.overrides.set('GET /api/local-agents/models', () =>
      json({ available: true, data: [{ id: 'example:local' }] }),
    );
    fixture.server.overrides.set('GET /api/codex/config/raw', () =>
      json({ content: 'model = "alpha"\n', filePath: 'config.toml' }),
    );
    fixture.server.overrides.set('GET /api/codex/cli', () =>
      json({
        installedVersion: '0.164.0-mergeron.1',
        selectedVersion: 'previous',
        installationState: 'managed',
        latestVersion: null,
        updateAvailable: false,
        canManage: true,
        canRollback: true,
        busy: false,
        officialUpdateBlocked: true,
        managedRelease: {
          id: '0.164.0-mergeron.1',
          manifestSha256: 'c'.repeat(64),
        },
      }),
    );
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      fixture.fetch(
        input instanceof Request
          ? input
          : new Request(new URL(String(input), location.origin), init),
      ),
    );
    fixture.render(
      <main className="flex h-[880px] w-full min-w-0 flex-col bg-background text-foreground [&_textarea]:w-full">
        <CodexSettings />
      </main>,
    );
    const label = (s: string) => i18n.t(translationKey(s));
    const tab = async (s: string) => {
      await page.getByRole('tab', { name: label(s), exact: true }).click();
    };
    const sub = async (key: string) => {
      await page
        .getByRole('tab', {
          name: i18n.t(translationKey(key), { ns: 'codexSettings' }),
          exact: true,
        })
        .click();
    };
    const seen = new Set<string>();
    async function inspect() {
      const body = document.querySelector<HTMLElement>('[data-settings-body]')!;
      const fixed = document.querySelector<HTMLElement>(
        '[data-settings-heading], [data-settings-navigation]',
      )!;
      const footer = document.querySelector<HTMLElement>(
        '[data-settings-actions]',
      )!;
      const before = fixed.getBoundingClientRect(),
        actions = footer.getBoundingClientRect();
      body.scrollTop = body.scrollHeight;
      expect(fixed.getBoundingClientRect().top).toBe(before.top);
      expect(footer.getBoundingClientRect().top).toBe(actions.top);
      expect(body.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        before.bottom - 1,
      );
      expect(body.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        actions.top + 1,
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      for (const field of FIELD_DEFS) {
        const el = document.getElementById('codex-field-' + field.key);
        if (el && !el.closest('[hidden], .hidden')) {
          expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(width);
          seen.add(field.key);
        }
      }
      for (const el of footer.querySelectorAll('button')) {
        const r = el.getBoundingClientRect();
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.right).toBeLessThanOrEqual(width);
        expect(r.bottom).toBeLessThanOrEqual(900);
      }
    }
    try {
      await tab('Model');
      await screen.findByRole('combobox', { name: label('Model') });
      await inspect();
      await sub('panelModelContext');
      await inspect();
      await page
        .getByRole('tab', { name: i18n.t('modelCatalog'), exact: true })
        .click();
      await screen.findByText('Alpha');
      await inspect();
      await sub('panelCatalogJson');
      await screen.findByRole('textbox', { name: 'Raw JSON' });
      await inspect();
      await tab('Instructions');
      const common = await screen.findByRole('textbox', {
        name: i18n.t('commonInstructionsLabel', { ns: 'codexSettings' }),
      });
      const bounds = common.getBoundingClientRect(),
        body = document.querySelector('[data-settings-body]')!;
      expect(bounds.width).toBeGreaterThan(body.clientWidth - 100);
      await inspect();
      await page.screenshot({
        path: `../../../.vitest-screenshots/codex-panel-instructions-${width}.png`,
      });
      await sub('panelSessionInstructions');
      await inspect();
      await sub('panelCompactInstructions');
      await inspect();
      await tab('Reasoning');
      await inspect();
      await tab('Profile');
      await inspect();
      expect([...seen].sort()).toEqual(FIELD_DEFS.map((f) => f.key).sort());
      await tab('Security');
      await inspect();
      await page
        .getByRole('tab', {
          name: i18n.t('localAgentsTitle', { ns: 'localAgents' }),
          exact: true,
        })
        .click();
      await screen.findByRole('checkbox');
      await inspect();
      await tab('Chat and Audio');
      await screen.findByLabelText(
        i18n.t('dictationBackendLabel', { ns: 'codexSettings' }),
      );
      await inspect();
      await tab('Raw configuration');
      await page
        .getByRole('button', { name: label('Edit config.toml') })
        .click();
      await screen.findByRole('textbox', { name: 'Raw TOML' });
      await inspect();
      await tab('Codex CLI');
      await screen.findByRole('button', {
        name: i18n.t('installManagedCli', { ns: 'codexSettings' }),
      });
      await inspect();
      expect(
        screen.queryByRole('button', { name: label('Save & Reload') }),
      ).toBeNull();
      await page.screenshot({
        path: `../../../.vitest-screenshots/codex-panel-cli-${width}.png`,
      });
      await tab('Account');
      await screen.findByRole('button', { name: label('logoutCodexAccount') });
      await inspect();
      expect(fixture.server.writes).toHaveLength(0);
      // A new subsection never triggers a hidden save or installation.
      fireEvent.click(screen.getByRole('tab', { name: label('Reasoning') }));
      expect(
        document.querySelectorAll('[data-settings-actions] [role="region"]'),
      ).toHaveLength(1);
    } finally {
      fixture.dispose();
    }
  });
