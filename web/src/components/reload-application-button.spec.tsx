import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ReloadApplicationButton } from './reload-application-button';

const reload = vi.hoisted(() => vi.fn());
vi.mock('@/lib/reload-application', () => ({ reloadApplication: reload }));

it('offers an accessible keyboard-operable full-app refresh button', () => {
  render(
    <TooltipProvider>
      <ReloadApplicationButton />
    </TooltipProvider>,
  );
  const button = screen.getByRole('button', { name: 'Refresh the app' });
  expect(button).toHaveAttribute('type', 'button');
  expect(button).toBeEnabled();
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(reload).toHaveBeenCalledTimes(1);
});
