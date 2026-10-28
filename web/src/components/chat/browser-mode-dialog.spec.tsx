import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { BrowserModeDialog } from './browser-mode-dialog';
beforeEach(async () => {
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
