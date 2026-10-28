import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectBrowserSettings } from './project-browser-settings';
import type { ProjectSummary } from '@/lib/projects-api';
import i18n from '@/i18n';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
beforeEach(async () => {
  await i18n.changeLanguage('en');
  api.mockReset().mockResolvedValue({});
});
it('defaults to Google and persists the project preferences', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectBrowserSettings project={{ id: 'p' } as ProjectSummary} />
    </QueryClientProvider>,
  );
  const address = screen.getByRole('textbox', { name: 'Default page' });
  expect(address).toHaveValue('https://www.google.com');
  expect(
    screen.getByRole('switch', { name: 'Open side by side on large screens' }),
  ).toBeChecked();
  fireEvent.change(address, { target: { value: 'https://example.org/' } });
  fireEvent.click(
    screen.getByRole('switch', { name: /Allow secondary windows/ }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/p/browser-settings', {
      method: 'PATCH',
      body: JSON.stringify({
        homeUrl: 'https://example.org/',
        desktopSplit: true,
        allowPopups: false,
      }),
    }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent('Settings saved');
});
