import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import {
  useQuery,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfileTextSize, ProfileTextSizeApplier } from './profile-text-size';
import {
  platformSessionKey,
  updateAuthResource,
  type PlatformSession,
} from '@/lib/platform-session';
import { useBreakpoint } from '@/hooks/use-breakpoint';
vi.mock('@/hooks/use-breakpoint', () => ({
  useBreakpoint: vi.fn(() => 'mobile'),
}));
vi.mock('@/lib/platform-session', async (original) => ({
  ...(await original<typeof import('@/lib/platform-session')>()),
  updateAuthResource: vi.fn(),
  usePlatformSession: () =>
    useQuery({
      queryKey: ['platform-session'],
      queryFn: () => {
        throw Error('No identity request permitted');
      },
      enabled: false,
    }),
}));
let client: QueryClient;
const profile = {
  kind: 'person',
  personId: 'one',
  active: true,
  textSizes: { mobile: 110, tablet: 100, desktop: 90 },
};
function View() {
  const { data } = useQuery<PlatformSession>({
    queryKey: platformSessionKey,
    enabled: false,
    queryFn: () => Promise.reject(Error('No identity network in fixture')),
  });
  return (
    <>
      <ProfileTextSizeApplier sizes={data?.textSizes} />
      <ProfileTextSize />
    </>
  );
}
const ui = () => (
  <QueryClientProvider client={client}>
    <View />
  </QueryClientProvider>
);
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(platformSessionKey, profile);
  vi.mocked(useBreakpoint).mockReturnValue('mobile');
  vi.mocked(updateAuthResource).mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
});
it('applies the saved support value, saves only that support and restores other support values on resize', async () => {
  vi.mocked(updateAuthResource).mockResolvedValue({
    textSizes: { ...profile.textSizes, mobile: 120 },
  });
  const view = render(ui());
  expect(document.documentElement.style.fontSize).toBe('110%');
  fireEvent.click(screen.getByRole('button', { name: 'Increase text size' }));
  await waitFor(() =>
    expect(document.documentElement.style.fontSize).toBe('120%'),
  );
  expect(updateAuthResource).toHaveBeenCalledWith('preferences', {
    textSize: { support: 'mobile', percent: 120 },
  });
  vi.mocked(useBreakpoint).mockReturnValue('desktop');
  view.rerender(ui());
  expect(document.documentElement.style.fontSize).toBe('90%');
  view.unmount();
  expect(document.documentElement.style.fontSize).toBe('');
  render(ui());
  expect(document.documentElement.style.fontSize).toBe('90%');
});
it('keeps the saved value on failure and offers reset with bounds', async () => {
  client.setQueryData(platformSessionKey, {
    ...profile,
    textSizes: { mobile: 80, tablet: 100, desktop: 150 },
  });
  vi.mocked(updateAuthResource).mockRejectedValue(Error('offline'));
  const view = render(ui());
  expect(
    screen.getByRole('button', { name: 'Decrease text size' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Increase text size' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to save');
  expect(document.documentElement.style.fontSize).toBe('80%');
  vi.mocked(updateAuthResource).mockResolvedValue({
    textSizes: { mobile: 100, tablet: 100, desktop: 150 },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  await waitFor(() =>
    expect(document.documentElement.style.fontSize).toBe('100%'),
  );
  vi.mocked(useBreakpoint).mockReturnValue('desktop');
  view.rerender(ui());
  expect(
    screen.getByRole('button', { name: 'Increase text size' }),
  ).toBeDisabled();
});
it('does not copy a late save response into a different user profile', async () => {
  let done!: (value: unknown) => void;
  vi.mocked(updateAuthResource).mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  render(ui());
  fireEvent.click(screen.getByRole('button', { name: 'Increase text size' }));
  await waitFor(() => expect(updateAuthResource).toHaveBeenCalled());
  client.setQueryData(platformSessionKey, {
    ...profile,
    personId: 'two',
    textSizes: { mobile: 100, tablet: 100, desktop: 100 },
  });
  done({ textSizes: { mobile: 120, tablet: 100, desktop: 90 } });
  await waitFor(() =>
    expect(document.documentElement.style.fontSize).toBe('100%'),
  );
  expect(
    client.getQueryData<PlatformSession>(platformSessionKey)?.personId,
  ).toBe('two');
});

it('keeps an in-flight mobile save bound to mobile when the viewport changes', async () => {
  let done!: (value: unknown) => void;
  vi.mocked(updateAuthResource).mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const view = render(ui());
  fireEvent.click(screen.getByRole('button', { name: 'Increase text size' }));
  vi.mocked(useBreakpoint).mockReturnValue('desktop');
  view.rerender(ui());
  await waitFor(() =>
    expect(updateAuthResource).toHaveBeenCalledWith('preferences', {
      textSize: { support: 'mobile', percent: 120 },
    }),
  );
  done({ textSizes: { mobile: 120, tablet: 100, desktop: 90 } });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Increase text size' }),
    ).toBeEnabled(),
  );
  expect(document.documentElement.style.fontSize).toBe('90%');
});
