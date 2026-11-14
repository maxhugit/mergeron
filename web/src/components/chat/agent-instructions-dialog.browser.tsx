import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { AgentInstructionsDialog } from './agent-instructions-dialog';
import type { ProjectWorkspaceCopySummary } from '@/lib/projects-api';
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({
    data: { kind: 'person', personId: 'fixture', role: 'administrator' },
  }),
}));
const status = {
  threadId: 'fixture-agent',
  copyId: 'copy',
  version: 1,
  events: [
    {
      id: 'check',
      trigger: 'manual',
      state: 'verified',
      revision: 'a'.repeat(64),
      sources: ['server', 'profile', 'project', 'git'].map((kind) => ({
        kind,
        revision: 'b'.repeat(64),
        ...(kind === 'git'
          ? {
              commit: 'a807b2a'.repeat(5),
              files: ['AGENTS.md', 'web/AGENTS.md'],
            }
          : {}),
      })),
      createdAt: Date.UTC(2026, 10, 13, 14, 32),
    },
    {
      id: 'supply',
      trigger: 'mcp',
      state: 'supplied',
      revision: 'a'.repeat(64),
      sources: [],
      createdAt: Date.UTC(2026, 10, 13, 14, 30),
    },
  ],
};
vi.mock('@/lib/agent-context-api', () => ({
  agentContextKey: (thread: string, person: string) => [
    'agent-context',
    person,
    thread,
  ],
  getAgentContext: async () => status,
  setAgentInstructionSource: async () => status,
  verifyAgentContext: async () => status,
  previewGitInstructions: async () => ({
    files: [
      {
        path: 'AGENTS.md',
        text: 'Préserver les permissions et vérifier les résultats.',
      },
    ],
  }),
}));
afterEach(cleanup);
test.each([390, 1100])(
  'instruction source dialog fits %ipx and exposes actual instruction preview',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 950);
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <AgentInstructionsDialog
          threadId="fixture-agent"
          copies={[
            {
              id: 'copy',
              name: 'Mergeron — copie locale',
              branch: 'main',
              sourceEnabled: true,
              sourceType: 'git',
              state: 'ready',
            } as ProjectWorkspaceCopySummary,
          ]}
          open
          onOpenChange={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole('combobox', { name: 'Copie Git de consignes' }),
    ).toBeVisible();
    expect(screen.getByText(/Vérifié, pas encore fourni ·/)).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: 'Voir les consignes Git actuelles' }),
    );
    expect(
      await screen.findByText(
        'Préserver les permissions et vérifier les résultats.',
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width),
    );
    const dialog = screen.getByRole('dialog').getBoundingClientRect();
    expect(dialog.left).toBeGreaterThanOrEqual(0);
    expect(dialog.right).toBeLessThanOrEqual(width);
    expect(screen.getByRole('button', { name: /^Fermer$/ })).toBeVisible();
    await page.screenshot({
      path: `../../../.vitest-screenshots/agent-instructions-${width}.png`,
    });
  },
);
