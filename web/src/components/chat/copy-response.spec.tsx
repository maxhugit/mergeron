import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CopyResponse } from './copy-response';

const mocks = vi.hoisted(() => ({ copy: vi.fn(), snackbar: vi.fn() }));
vi.mock('@/lib/formatted-clipboard', () => ({
  copyFormattedResponse: mocks.copy,
}));
vi.mock('@/stores/snackbar-store', () => ({ showSnackbar: mocks.snackbar }));

it('puts the copy action before the response and copies only its body', async () => {
  mocks.copy.mockResolvedValue(undefined);
  render(
    <CopyResponse completed empty={false}>
      <p>Réponse</p>
    </CopyResponse>,
  );
  const button = screen.getByRole('button');
  fireEvent.click(button);
  await waitFor(() => expect(mocks.snackbar).toHaveBeenCalled());
  const body = mocks.copy.mock.calls[0][0] as HTMLElement;
  expect(body.textContent).toBe('Réponse');
  expect(body.querySelector('button')).toBeNull();
});

it('disables copying incomplete or empty answers', () => {
  const { rerender } = render(
    <CopyResponse completed={false} empty={false}>
      En cours
    </CopyResponse>,
  );
  expect(screen.getByRole('button')).toBeDisabled();
  rerender(
    <CopyResponse completed empty>
      {' '}
    </CopyResponse>,
  );
  expect(screen.getByRole('button')).toBeDisabled();
});
