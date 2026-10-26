import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CopyResponse } from './copy-response';
import { TooltipProvider } from '@/components/ui/tooltip';

function Response(props: React.ComponentProps<typeof CopyResponse>) {
  return (
    <TooltipProvider>
      <CopyResponse {...props} />
    </TooltipProvider>
  );
}

const mocks = vi.hoisted(() => ({ copy: vi.fn(), snackbar: vi.fn() }));
vi.mock('@/lib/formatted-clipboard', () => ({
  copyFormattedResponse: mocks.copy,
}));
vi.mock('@/stores/snackbar-store', () => ({ showSnackbar: mocks.snackbar }));

it('puts the copy action before the response and copies only its body', async () => {
  mocks.copy.mockResolvedValue(undefined);
  render(
    <Response completed empty={false}>
      <p>Réponse</p>
    </Response>,
  );
  const button = screen.getByRole('button');
  expect(button).toHaveAccessibleName('Copy with formatting');
  expect(button.textContent).toBe('');
  expect(button).toHaveClass(
    'absolute',
    'right-0',
    'top-0',
    'hover-reveal',
    'group-hover/response:opacity-100',
  );
  fireEvent.click(button);
  await waitFor(() => expect(mocks.snackbar).toHaveBeenCalled());
  const body = mocks.copy.mock.calls[0][0] as HTMLElement;
  expect(body.textContent).toBe('Réponse');
  expect(body.querySelector('button')).toBeNull();
});

it('disables copying incomplete or empty answers', () => {
  const { rerender } = render(
    <Response completed={false} empty={false}>
      En cours
    </Response>,
  );
  expect(screen.getByRole('button')).toBeDisabled();
  rerender(
    <Response completed empty>
      {' '}
    </Response>,
  );
  expect(screen.getByRole('button')).toBeDisabled();
});
