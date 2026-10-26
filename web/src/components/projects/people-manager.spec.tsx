import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

  expect(await screen.findByText(/Connected since/)).toBeInTheDocument();
  expect(screen.getByRole('table')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Actions —/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Force sign out' }));

  await waitFor(() =>
    expect(auth.request).toHaveBeenCalledWith('sessions/maxime/revoke', {
      method: 'POST',
    }),
  );
});
