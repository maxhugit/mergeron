import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProfileLanguageSwitch } from './profile-language-switch';
import {
  platformSessionKey,
  updateAuthResource,
  type PlatformSession,
} from '@/lib/platform-session';
import i18n, { i18nReady } from '@/i18n';
const identity = vi.hoisted(() => ({
  kind: 'person',
  active: true,
  personId: 'person-a',
  language: 'en',
}));
vi.mock('@/lib/platform-session', () => ({
  platformSessionKey: ['platform-session'],
  usePlatformSession: () => ({ data: identity }),
  updateAuthResource: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.mocked(updateAuthResource).mockReset();
});
async function setup() {
  await i18nReady;
  await i18n.changeLanguage('en');
  const client = new QueryClient();
  client.setQueryData(platformSessionKey, identity);
  render(
    <QueryClientProvider client={client}>
      <ProfileLanguageSwitch />
    </QueryClientProvider>,
  );
  return client;
}
test('changes the interface immediately and saves the connected person’s language', async () => {
  vi.mocked(updateAuthResource).mockResolvedValue({ language: 'fr' });
  const client = await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Français' }));
  await waitFor(() => expect(i18n.language).toBe('fr'));
  expect(updateAuthResource).toHaveBeenCalledWith('preferences', {
    language: 'fr',
  });
  await waitFor(() =>
    expect(
      client.getQueryData<PlatformSession>(platformSessionKey)?.language,
    ).toBe('fr'),
  );
});
test('a delayed save never overwrites another person’s profile cache', async () => {
  let finish!: (value: object) => void;
  vi.mocked(updateAuthResource).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Français' }));
  await waitFor(() => expect(updateAuthResource).toHaveBeenCalled());
  client.setQueryData(platformSessionKey, {
    ...identity,
    personId: 'person-b',
    language: 'en',
  });
  finish({ language: 'fr' });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'English' })).not.toBeDisabled(),
  );
  expect(
    client.getQueryData<PlatformSession>(platformSessionKey)?.language,
  ).toBe('en');
});
