/** Real menus, nested dialogs and responsive layout; only retention HTTP is mocked. */
import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { LogRetentionDialog } from './log-retention-dialog';
import type { LogStorage } from '@/lib/logs-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

const api = vi.hoisted(() => ({ saveLogRetentionRule: vi.fn() }));
vi.mock('@/lib/logs-api', () => api);
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  vi.clearAllMocks();
});

const policy: LogStorage['policy'] = {
  application: { enabled: true, maxAgeDays: 5, maxFiles: 5 },
  codex: { enabled: true, maxAgeDays: 5, maxFiles: 5, maxFileMiB: 50 },
};
const files: LogStorage['files'] = [
  ...Array.from({ length: 6 }, (_, index) => ({
    name: `app.${40 + index}.log`,
    bytes: (index === 5 ? 5 : 10) * 1024 ** 2,
    modifiedAt: 1793440000000,
    family: 'application' as const,
    active: index === 5,
  })),
  {
    name: 'codex-jsonrpc.1793440000000-11111111-1111-1111-1111-111111111111.jsonl',
    bytes: 8144638328,
    modifiedAt: 1793440000000,
    family: 'codex',
    active: false,
  },
  {
    name: 'codex-jsonrpc.jsonl',
    bytes: 3 * 1024 ** 2,
    modifiedAt: 1793440000000,
    family: 'codex',
    active: true,
  },
  {
    name: 'unknown.log',
    bytes: 128,
    modifiedAt: 1793440000000,
    family: 'other',
    active: false,
  },
];

test.each([390, 947, 1280])(
  'shows retention summaries and edits one family without losing the table at %ipx',
  async (width) => {
    await page.viewport(width, 913);
    await i18nReady;
    await i18n.changeLanguage('fr');
    document.documentElement.classList.add('dark');
    api.saveLogRetentionRule.mockResolvedValue({ policy });
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <LogRetentionDialog
          storage={{
            files,
            policy,
            estimatedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
          }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    try {
      const summary = screen.getByRole('dialog', {
        name: 'Rétention des logs',
      });
      expect(
        within(summary).getByRole('row', { name: /Codex JSON-RPC/ }),
      ).toHaveTextContent('1 / 5');
      const bounds = summary.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const engine =
        navigator.userAgent.includes('WebKit') &&
        !navigator.userAgent.includes('Chrome')
          ? 'webkit'
          : 'chromium';
      await page.screenshot({
        path: `../../../.vitest-screenshots/log-retention-table-${engine}-${width}.png`,
      });
      const actions = page.getByRole('button', {
        name: 'Actions · Codex JSON-RPC',
      });
      await actions.click();
      await page
        .getByRole('menuitem', { name: 'Paramétrer la rétention' })
        .click();
      const editor = await screen.findByRole('dialog', {
        name: 'Journaux · Codex JSON-RPC',
      });
      await expect.poll(() => getComputedStyle(summary).display).toBe('none');
      await expect
        .poll(() => getComputedStyle(editor).visibility)
        .toBe('visible');
      expect(summary).not.toBeVisible();
      expect(within(editor).getByRole('note')).toHaveTextContent(
        'pas une limite de taille totale',
      );
      expect(within(editor).getByText('codex-jsonrpc.jsonl')).toBeVisible();
      expect(editor.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `../../../.vitest-screenshots/log-retention-editor-${engine}-${width}.png`,
      });
      await page.getByRole('button', { name: 'Annuler' }).click();
      await expect
        .poll(() =>
          screen.queryByRole('dialog', { name: 'Journaux · Codex JSON-RPC' }),
        )
        .toBeNull();
      expect(api.saveLogRetentionRule).not.toHaveBeenCalled();
      await expect
        .poll(() => document.activeElement?.getAttribute('aria-label'))
        .toBe('Actions · Codex JSON-RPC');
      // Same menu from the explicit overflow button's right-click surface.
      await actions.click({ button: 'right' });
      await page
        .getByRole('menuitem', { name: 'Paramétrer la rétention' })
        .click();
      const rule = await screen.findByLabelText(
        'Nombre maximal d’archives (hors fichier actif)',
      );
      fireEvent.change(rule, { target: { value: '3' } });
      await page.getByRole('button', { name: 'Enregistrer' }).click();
      await expect
        .poll(() => api.saveLogRetentionRule.mock.calls.length)
        .toBe(1);
      expect(api.saveLogRetentionRule).toHaveBeenCalledWith('codex', {
        ...policy.codex,
        maxFiles: 3,
      });
      await expect
        .poll(() =>
          screen.queryByRole('dialog', { name: 'Journaux · Codex JSON-RPC' }),
        )
        .toBeNull();
      expect(screen.getByRole('table')).toBeVisible();
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
