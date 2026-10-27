import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PeopleManager } from './people-manager';

const api = vi.hoisted(() => vi.fn().mockResolvedValue({ person: {} }));
const peopleState = vi.hoisted(() => ({
  people: [] as Record<string, unknown>[],
}));
const auth = vi.hoisted(() => ({
  request: vi.fn().mockResolvedValue({ revoked: true }),
  accounts: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
vi.mock('@/lib/people-api', () => ({
  usePeople: () => ({ data: { people: peopleState.people }, isPending: false }),
  useParticipants: () => ({ data: { participants: [] }, isPending: false }),
  peopleKey: ['people'],
  personLabel: (p: { name: string }) => p.name,
}));
vi.mock('@/lib/auth-api', () => ({
  authRequest: auth.request,
  localAccountsKey: ['authentication', 'local-accounts'],
  readLocalAccounts: () => Promise.resolve({ accounts: auth.accounts }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: globalThis.__testTranslate,
    i18n: { resolvedLanguage: 'en' },
  }),
}));
beforeEach(() => {
  api.mockClear();
  auth.request.mockClear();
  peopleState.people = [];
  auth.accounts = [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('requires first name, last name, email and phone, computes full name, and defaults to standard', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PeopleManager />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New person' }));
  for (const name of [/^First name/, /^Last name/, /^Email/, /^Phone number/]) {
    expect((screen.getByLabelText(name) as HTMLInputElement).required).toBe(
      true,
    );
  }
  const fullName = screen.getByLabelText('Full name') as HTMLInputElement;
  expect(fullName.readOnly).toBe(true);
  fireEvent.change(screen.getByLabelText(/^Manual reference/), {
    target: { value: 'TEST' },
  });
  fireEvent.change(screen.getByLabelText(/^First name/), {
    target: { value: 'Alice' },
  });
  fireEvent.change(screen.getByLabelText(/^Last name/), {
    target: { value: 'Test' },
  });
  fireEvent.change(screen.getByLabelText(/^Email/), {
    target: { value: 'alice@example.com' },
  });
  fireEvent.change(screen.getByLabelText(/^Phone number/), {
    target: { value: '0600000000' },
  });
  expect(fullName.value).toBe('Alice Test');
  expect(
    (screen.getByLabelText(/^Platform role/) as HTMLSelectElement).value,
  ).toBe('standard');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(JSON.parse(api.mock.calls[0][1].body)).toMatchObject({
    firstName: 'Alice',
    lastName: 'Test',
    email: 'alice@example.com',
    phone: '0600000000',
    role: 'standard',
  });
});

it('shows live presence and lets an administrator revoke all sessions', async () => {
  peopleState.people = [
    {
      id: 'maxime',
      reference: 'MZH',
      name: 'Maxime HUGOT',
      firstName: 'Maxime',
      lastName: 'HUGOT',
      phone: '06 47 08 36 82',
      role: 'administrator',
      identityLinked: true,
      email: 'maxime@example.com',
      active: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  auth.accounts = [
    {
      personId: 'maxime',
      connected: true,
      connectedSince: Date.UTC(2026, 9, 21, 10, 30),
      lastSeenAt: Date.UTC(2026, 9, 21, 10, 31),
      activeSessionCount: 1,
    },
  ];
  vi.spyOn(window, 'confirm').mockReturnValue(true);

  render(
    <QueryClientProvider client={new QueryClient()}>
      <PeopleManager />
    </QueryClientProvider>,
  );

  expect(
    await screen.findByRole('cell', { name: /^Connected$/ }),
  ).toBeInTheDocument();
  expect(screen.getByRole('table')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Actions —/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Force sign out' }));

  await waitFor(() =>
    expect(auth.request).toHaveBeenCalledWith('sessions/maxime/revoke', {
      method: 'POST',
    }),
  );
});

function tablePeople() {
  peopleState.people = [
    {
      id: 'z',
      name: 'Zoé Test',
      reference: 'TEST-2',
      firstName: 'Zoé',
      lastName: 'Test',
      email: 'a@example.invalid',
      active: true,
      role: 'standard',
      phone: '02',
      identityLinked: true,
    },
    {
      id: 'a',
      name: 'Alice Test',
      reference: 'TEST-10',
      firstName: 'Alice',
      lastName: 'Test',
      email: 'z@example.invalid',
      active: false,
      role: 'administrator',
      phone: '10',
      identityLinked: false,
    },
    {
      id: 'n',
      name: 'Sans Email',
      reference: 'TEST-11',
      firstName: 'Sans',
      lastName: 'Email',
      email: null,
      active: true,
      role: 'standard',
      phone: '',
      identityLinked: false,
    },
  ];
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PeopleManager />
    </QueryClientProvider>,
  );
}

const bodyRows = () => screen.getAllByRole('row').slice(1);
const firstName = () =>
  within(bodyRows()[0]).getAllByRole('cell')[0].textContent?.trim();

it('shows one piece of information per cell, with sortable accessible column headers', () => {
  tablePeople();
  expect(screen.getAllByRole('columnheader')).toHaveLength(10);
  const row = bodyRows().find((row) => within(row).queryByText('Zoé Test'))!;
  expect(
    within(row)
      .getAllByRole('cell')
      .slice(0, 7)
      .map((cell) => cell.textContent?.trim()),
  ).toEqual([
    'Zoé Test',
    'TEST-2',
    'a@example.invalid',
    'Active',
    'Standard user',
    '02',
    'Login linked',
  ]);
  const header = screen.getByRole('columnheader', { name: 'Manual reference' });
  fireEvent.click(within(header).getByRole('button'));
  expect(header).toHaveAttribute('aria-sort', 'ascending');
  expect(firstName()).toBe('Zoé Test');
  fireEvent.click(within(header).getByRole('button'));
  expect(header).toHaveAttribute('aria-sort', 'descending');
  expect(firstName()).toBe('Sans Email');
  expect(api).not.toHaveBeenCalled();
});

it('keeps missing values last in both sort directions and preserves sorting when searching', () => {
  tablePeople();
  const header = screen.getByRole('columnheader', { name: 'Email' });
  fireEvent.click(within(header).getByRole('button'));
  expect(firstName()).toBe('Zoé Test');
  expect(bodyRows().at(-1)?.textContent).toContain('Sans Email');
  fireEvent.click(within(header).getByRole('button'));
  expect(firstName()).toBe('Alice Test');
  expect(bodyRows().at(-1)?.textContent).toContain('Sans Email');
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'TEST-2' },
  });
  expect(bodyRows()).toHaveLength(1);
  expect(firstName()).toBe('Zoé Test');
  expect(header).toHaveAttribute('aria-sort', 'descending');
});

it('sorts connection dates by timestamps rather than their formatted text', async () => {
  auth.accounts = [
    { personId: 'z', connected: true, connectedSince: Date.UTC(2026, 9, 31) },
    { personId: 'a', connected: true, connectedSince: Date.UTC(2026, 10, 1) },
  ];
  tablePeople();
  await waitFor(() =>
    expect(screen.getAllByRole('cell', { name: /^Connected$/ })).toHaveLength(
      2,
    ),
  );
  const header = screen.getByRole('columnheader', { name: 'Connected since' });
  fireEvent.click(within(header).getByRole('button'));
  expect(firstName()).toBe('Zoé Test');
  fireEvent.click(within(header).getByRole('button'));
  expect(firstName()).toBe('Alice Test');
});
