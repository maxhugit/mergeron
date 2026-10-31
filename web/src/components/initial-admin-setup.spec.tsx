import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InitialSetupGate } from './initial-admin-setup';
import { installSessionRecovery } from '@/lib/session-recovery';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = () =>
  render(
    <InitialSetupGate>
      <p>Normal login</p>
    </InitialSetupGate>,
  );
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
it('keeps existing installations on ordinary login without submitting any mutation', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(response({ required: false, authorized: false }));
  vi.stubGlobal('fetch', fetch);
  mount();
  expect(await screen.findByText('Normal login')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][1].method).toBe('GET');
});
it('never mounts login on an unavailable or malformed setup state, and retries without reloading', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({}))
    .mockResolvedValue(response({ required: false, authorized: false }));
  vi.stubGlobal('fetch', fetch);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Normal login')).toBeInTheDocument();
});
it('uses explicit code validation and confirmation, works before authentication, and never stores the password locally', async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/status'))
      return response({
        required: true,
        authorized: false,
        containerName: 'mergeron-dev-ui',
      });
    if (url.endsWith('/verify')) {
      expect(JSON.parse(init!.body as string)).toEqual({
        code: 'one-use-code',
      });
      return response({ authorized: true, csrfToken: 'csrf' });
    }
    expect(JSON.parse(init!.body as string)).toMatchObject({
      csrfToken: 'csrf',
      password: 'a-long-password',
    });
    return response({ completed: true });
  });
  vi.stubGlobal('fetch', fetch);
  const dispose = installSessionRecovery();
  try {
    mount();
    fireEvent.change(await screen.findByLabelText('Activation code'), {
      target: { value: 'one-use-code' },
    });
    expect(
      screen.getByText(/docker exec -it mergeron-dev-ui/),
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Validate code' }));
    for (const [label, value] of [
      ['First name', 'First'],
      ['Last name', 'Admin'],
      ['Email address', 'admin@example.test'],
      ['Username', 'admin'],
      ['Password', 'a-long-password'],
      ['Confirm password', 'a-long-password'],
    ])
      fireEvent.change(await screen.findByLabelText(label), {
        target: { value },
      });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create administrator' }),
    );
    expect(
      await screen.findByText('Your administrator is ready'),
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(window.localStorage.getItem('password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Normal login')).toBeInTheDocument();
  } finally {
    dispose();
  }
});
it('restores only the restricted setup session on refresh and keeps errors visible after a rejected create', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/status')
        ? response({ required: true, authorized: true, csrfToken: 'csrf' })
        : response({}, 403),
    ),
  );
  mount();
  expect(await screen.findByLabelText('First name')).toBeInTheDocument();
  expect(screen.queryByLabelText('Activation code')).toBeNull();
  for (const [label, value] of [
    ['First name', 'First'],
    ['Last name', 'Admin'],
    ['Email address', 'admin@example.test'],
    ['Username', 'admin'],
    ['Password', 'a-long-password'],
    ['Confirm password', 'a-long-password'],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to create'),
  );
  expect(screen.queryByText('Normal login')).toBeNull();
});
