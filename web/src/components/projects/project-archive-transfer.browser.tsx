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
import { CreateProjectDialog } from '@/components/chat/sidebar/create-project-dialog';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test.each([390, 1001])(
  'keeps person choices accessible before import at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('en');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 'test-preview',
          projectName: 'Imported project',
          sourceVersion: '0.2.1',
          targetVersion: '0.3.0',
          files: 1,
          bytes: 42,
          warnings: [],
          people: [
            {
              id: 'source',
              name: 'Maxime HUGOT',
              reference: 'IMPORT-source',
              email: 'source@example.test',
            },
          ],
          availablePeople: [
            {
              id: 'target',
              name: 'Maxime HUGOT',
              reference: 'DEV-ADMIN',
              email: 'target@example.test',
              active: true,
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateProjectDialog
          open
          pending={false}
          name=""
          onNameChange={() => {}}
          onSave={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole('tab', { name: 'Import a project from ZIP' }),
    );
    fireEvent.change(screen.getByLabelText('Project archive'), {
      target: { files: [new File(['zip'], 'project.zip')] },
    });
    const select = await screen.findByRole('combobox', {
      name: 'Mapping for Maxime HUGOT',
    });
    const submit = screen.getByRole('button', {
      name: 'Create project from ZIP',
    });
    expect(submit).toBeDisabled();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    select.scrollIntoView();
    expect(select.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(select.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
    fireEvent.change(select, { target: { value: 'target' } });
    await waitFor(() => expect(submit).toBeEnabled());
    expect(
      screen.getByRole('option', {
        name: 'Create a new person (inactive contact)',
      }),
    ).toBeInTheDocument();
  },
);
