import { StrictMode, useState } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useSilentSessionRenewal } from './silent-session-renewal';
import '@/index.css';

vi.mock('@/base-path', () => ({
  withBasePath: (path: string) =>
    path.replace('/api/auth/session/renew', '/__silent_renewal/start'),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.cookie = 'silent_renewal_fixture=; Max-Age=0; Path=/';
});

export function Probe({ verify }: { verify: () => Promise<boolean> }) {
  const [enabled, setEnabled] = useState(false);
  const state = useSilentSessionRenewal(enabled, 1, verify);
  return (
    <main style={{ padding: 24 }}>
      <textarea aria-label="Draft" defaultValue="" />
      <button onClick={() => setEnabled(true)}>
        Simulate expired application session
      </button>
      <p role="status">
        {state === 'running' ? 'Reprise de session en cours…' : state}
      </p>
    </main>
  );
}

test.each([390, 1180])(
  'completes a real two-origin redirect and CSP-protected return without popup, navigation or lost draft at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    const open = vi.spyOn(window, 'open');
    const verify = vi.fn(async () => true);
    const view = render(
      <StrictMode>
        <Probe verify={verify} />
      </StrictMode>,
    );
    const input = screen.getByRole('textbox', { name: 'Draft' });
    fireEvent.change(input, { target: { value: 'UNSENT_SYNTHETIC_DRAFT' } });
    const href = window.location.href;
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(verify).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('idle'),
    );
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).toHaveValue('UNSENT_SYNTHETIC_DRAFT');
    expect(window.location.href).toBe(href);
    expect(open).not.toHaveBeenCalled();
    expect(
      document.querySelector('iframe[title="Session renewal"]'),
    ).toBeNull();
    await page.screenshot({
      path: `../../.vitest-screenshots/silent-session-${width}.png`,
    });
    view.unmount();
  },
);

test('reports interaction required without automatic visible navigation or fresh authorization', async () => {
  document.cookie = 'silent_renewal_fixture=interactive; Path=/; SameSite=Lax';
  const verify = vi.fn(async () => true);
  const href = window.location.href;
  render(<Probe verify={verify} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('interactive'),
  );
  expect(verify).not.toHaveBeenCalled();
  expect(window.location.href).toBe(href);
});
