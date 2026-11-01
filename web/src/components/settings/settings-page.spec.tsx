import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsPage } from './settings-page';
import { settingsPageLabel, settingsPageDescription } from './setting-helpers';
import { SETTINGS_SECTIONS } from './settings-sections';
const route = vi.hoisted(() => ({ section: 'general' }));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { search: route } }),
}));
vi.mock('./manager-status-card', () => ({
  ManagerStatusCard: () => <div>Manager infrastructure inventory</div>,
}));
vi.mock('./server-version-card', () => ({
  ServerVersionCard: () => <div>Application updates</div>,
}));
vi.mock('./codex-settings', () => ({
  CodexSettings: ({ initialTab }: { initialTab?: string }) => (
    <div>Codex {initialTab} tabs</div>
  ),
}));
vi.mock('./internal-mcp-settings', () => ({
  InternalMcpSettings: () => <div>Native MCP technical reference</div>,
}));
vi.mock('./use-category-settings', () => ({
  useCategorySettings: () => ({
    settings: [],
    drafts: {},
    isDirty: false,
    isLoading: false,
  }),
}));
afterEach(cleanup);
it('keeps the old simple-chat URL pointing to Codex Chat and Audio', async () => {
  route.section = 'simpleChat';
  render(<SettingsPage />);
  expect(await screen.findByText('Codex chatAudio tabs')).toBeVisible();
  expect(settingsPageLabel('simpleChat')).toBe('Codex');
});
it('opens the internal MCP technical reference from its administration route', async () => {
  route.section = 'internalMcp';
  render(<SettingsPage />);
  expect(
    await screen.findByText('Native MCP technical reference'),
  ).toBeVisible();
  expect(SETTINGS_SECTIONS).toContain('internalMcp');
  expect(settingsPageLabel('internalMcp')).toBe('internalMcpTitle');
});
it('opens the new Codex account tab from the old account URL', async () => {
  route.section = 'account';
  render(<SettingsPage />);
  expect(await screen.findByText('Codex account tabs')).toBeVisible();
});
it('keeps application updates on Server without the infrastructure inventory', async () => {
  route.section = 'general';
  render(<SettingsPage />);
  expect(await screen.findByText('Application updates')).toBeVisible();
  expect(screen.queryByText('Manager infrastructure inventory')).toBeNull();
  expect(settingsPageLabel('general')).toBe('Server');
  const tabs = screen.getByRole('tablist', { name: 'Server settings' });
  expect(tabs.parentElement).toHaveClass('h-10', 'shrink-0', 'border-b');
  expect(tabs.closest('.max-w-4xl')).toBeNull();
});
it('opens CLI inside Codex through the legacy URL', async () => {
  route.section = 'codexCli';
  render(<SettingsPage />);
  expect(await screen.findByText('Codex cli tabs')).toBeVisible();
});
it('loads the Manager on the Infrastructure route without duplicating update controls', async () => {
  route.section = 'infrastructure';
  render(<SettingsPage />);
  expect(
    await screen.findByText('Manager infrastructure inventory'),
  ).toBeVisible();
  expect(
    screen.getByText('Manager infrastructure inventory').closest('.max-w-4xl'),
  ).toBeNull();
  expect(screen.queryByText('Application updates')).toBeNull();
  expect(SETTINGS_SECTIONS).toContain('infrastructure');
  expect(settingsPageLabel('infrastructure')).toBe('managerInfrastructure');
  expect(settingsPageDescription('infrastructure')).toBe(
    'managerInfrastructureDescription',
  );
});

it('keeps the former integrations URL inside the Codex integrations tab', async () => {
  route.section = 'integrations';
  render(<SettingsPage />);
  expect(await screen.findByText('Codex integrations tabs')).toBeVisible();
  expect(settingsPageLabel('integrations')).toBe('Codex');
});
