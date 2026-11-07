import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
const capabilityFixture = vi.hoisted(() => ({ installed: true }));
vi.mock('../settings/server-capabilities-api', () => ({
  useServerCapabilities: () => ({
    data: {
      capabilities: [{ id: 'browser', installed: capabilityFixture.installed }],
    },
  }),
}));
import { BrowserModeDialog } from './browser-mode-dialog';
beforeEach(async () => {
  capabilityFixture.installed = true;
  await i18n.changeLanguage('en');
});
it.each(['isolated', 'local'] as const)(
  'requires explicit selection of %s and preserves both choices',
  (mode) => {
    const choose = vi.fn();
    render(<BrowserModeDialog open onOpenChange={vi.fn()} onChoose={choose} />);
    expect(
      screen.getByRole('button', { name: 'Isolated browser (existing)' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Local browser · extension (test)' }),
    ).toBeEnabled();
    expect(choose).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', {
        name:
          mode === 'isolated'
            ? 'Isolated browser (existing)'
            : 'Local browser · extension (test)',
      }),
    );
    expect(choose).toHaveBeenCalledExactlyOnceWith(mode);
  },
);
it('keeps the extension connection available when the isolated browser limit is reached', () => {
  render(
    <BrowserModeDialog
      open
      onOpenChange={vi.fn()}
      onChoose={vi.fn()}
      isolatedDisabled
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Isolated browser (existing)' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Local browser · extension (test)' }),
  ).toBeEnabled();
});

it('disables an absent isolated capability while retaining the local extension choice', () => {
  capabilityFixture.installed = false;
  const choose = vi.fn();
  render(<BrowserModeDialog open onOpenChange={vi.fn()} onChoose={choose} />);
  const isolated = screen.getByRole('button', { name: /Not installed/ });
  expect(isolated).toBeDisabled();
  fireEvent.click(isolated);
  expect(choose).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: 'Local browser · extension (test)' }),
  ).toBeEnabled();
});
