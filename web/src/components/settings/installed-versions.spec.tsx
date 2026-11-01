import { render, screen, within, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
vi.mock('./manager-image-updates-api', async (original) => ({
  ...(await original<typeof import('./manager-image-updates-api')>()),
  requestComponentUpdates: async () => ({ components: [] }),
}));
function draw(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}
import i18n from '@/i18n';
import { InstalledVersions } from './installed-versions';
import type { ManagerStatus } from './manager-status-api';

afterEach(cleanup);
const build = {
  version: '0.5.1',
  channel: 'edge' as const,
  revision: 'a'.repeat(40),
  builtAt: '2026-10-31T12:00:00Z',
};

it('separates installed revisions with equal versions and keeps Manager host-managed', async () => {
  await i18n.changeLanguage('en');
  draw(
    <InstalledVersions
      application={build}
      status={
        {
          available: true,
          observedAt: '2026-10-31T13:00:00Z',
          manager: {
            build: { ...build, revision: 'b'.repeat(40) },
            imageId: `sha256:${'2'.repeat(64)}`,
          },
          components: [
            { id: 'browser', build: { ...build, revision: 'c'.repeat(40) } },
          ],
        } as ManagerStatus
      }
    />,
  );
  const table = screen.getByRole('table');
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(6);
  expect(within(rows[1]).getByRole('link')).toHaveAttribute(
    'href',
    `https://github.com/maxhugit/mergeron/commit/${build.revision}`,
  );
  expect(within(rows[2]).getByRole('link')).toHaveTextContent('bbbbbbb');
  expect(within(rows[3]).getByRole('link')).toHaveTextContent('ccccccc');
  expect(screen.getAllByText('0.5.1')).toHaveLength(3);
  expect(
    screen.getByRole('button', { name: 'Update selected (0)' }),
  ).toBeDisabled();
  expect(
    within(rows[2]).getByRole('button', { name: 'On the host' }),
  ).toBeEnabled();
});

it('reports unknown with an older/offline Manager instead of copying the application version', async () => {
  await i18n.changeLanguage('en');
  draw(
    <InstalledVersions
      application={build}
      status={
        {
          available: false,
          components: [],
          mode: 'observe',
          dockerConnected: false,
          dataSafety: { status: 'unknown', blockers: [], protectedMounts: [] },
          manager: { build, imageId: `sha256:${'2'.repeat(64)}` },
        } as ManagerStatus
      }
    />,
  );
  const rows = screen.getAllByRole('row');
  for (const row of rows.slice(2)) {
    expect(within(row).queryByText('0.5.1')).not.toBeInTheDocument();
    expect(within(row).getAllByText(/Not reported/).length).toBeGreaterThan(0);
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
  }
});
