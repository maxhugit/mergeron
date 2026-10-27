import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { SettingsPage } from '@/components/settings/settings-page';

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { search: { section: 'people' } } }),
}));
vi.mock('@/lib/people-api', () => ({
  usePeople: () => ({
    data: {
      people: Array.from({ length: 40 }, (_, index) => ({
        id: `person-${index}`,
        name: `Personne ${index}`,
        firstName: 'Personne',
        lastName: String(index),
        reference: `TEST-${index}`,
        email: `personne.${index}@example.invalid`,
        phone: `00000000${index}`,
        role: 'standard',
        active: index % 2 === 0,
        identityLinked: false,
      })),
    },
    isPending: false,
  }),
  useParticipants: () => ({ data: { participants: [] }, isPending: false }),
  peopleKey: ['people'],
  personLabel: (person: { name: string }) => person.name,
}));
vi.mock('@/lib/auth-api', () => ({
  authRequest: vi.fn(),
  localAccountsKey: ['authentication', 'local-accounts'],
  readLocalAccounts: async () => ({ accounts: [] }),
}));

afterEach(cleanup);

test.each([1307, 1000, 390])(
  'uses the available width and retains sticky, keyboard-sortable headers at %i px',
  async (width) => {
    await page.viewport(width, 800);
    await i18nReady;
    await i18n.changeLanguage('fr');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <div className="flex h-dvh min-w-0 flex-col">
          <SettingsPage />
        </div>
      </QueryClientProvider>,
    );
    const table = await screen.findByRole('table', { name: 'Personnes' });
    expect(table.closest('.max-w-4xl')).toBeNull();
    expect(screen.getAllByRole('columnheader')).toHaveLength(10);
    const scroller = screen.getByRole('region', { name: 'Personnes' });
    expect(scroller.getBoundingClientRect().width).toBeGreaterThanOrEqual(
      width - 48,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const header = screen.getByRole('columnheader', {
      name: 'Référence manuelle',
    });
    const headerTop = table.querySelector('thead')!.getBoundingClientRect().top;
    scroller.scrollTop = 250;
    await expect.poll(() => scroller.scrollTop).toBeGreaterThan(0);
    expect(
      Math.abs(
        table.querySelector('thead')!.getBoundingClientRect().top - headerTop,
      ),
    ).toBeLessThan(1);
    scroller.scrollLeft = 0;
    const sortButton = within(header).getByRole('button');
    sortButton.focus();
    await userEvent.keyboard('{Enter}');
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(sortButton);
    expect(header).toHaveAttribute('aria-sort', 'descending');
    const row = table.querySelector('tbody tr')!;
    expect(row.querySelector('td')?.textContent).toContain('Personne 39');
    if (width === 1307) {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      await page.screenshot({
        path: '../../../.vitest-screenshots/people-table-preview.png',
      });
    }
  },
);
