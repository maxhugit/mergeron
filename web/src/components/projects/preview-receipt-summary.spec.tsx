import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { PreviewReceiptSummary } from './preview-receipt-summary';
import { previewsVerify } from '@/generated/api';
import i18n, { i18nReady } from '@/i18n';
vi.mock('@/generated/api', () => ({ previewsVerify: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('exposes the immutable receipt and opens only the authorized preview origin', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  const replace = vi.fn(),
    close = vi.fn();
  vi.spyOn(window, 'open').mockReturnValue({
    opener: null,
    location: { replace },
    close,
  } as unknown as Window);
  vi.mocked(previewsVerify).mockResolvedValue({
    data: {
      url: 'https://test.preview.example/.__mergeron_preview/open#fixture',
      expiresAt: 123,
    },
    response: new Response(),
    request: new Request('https://mergeron.test'),
  });
  const receipt = {
    schemaVersion: 1 as const,
    generation: '11111111-1111-4111-8111-111111111111',
    archiveSha: 'a'.repeat(64),
    sourceFingerprint: 'b'.repeat(64),
    gitCommit: 'c'.repeat(40),
    copyId: 'own-copy',
    syncedAt: 123,
  };
  render(
    <PreviewReceiptSummary
      receipt={receipt}
      projectId="p"
      threadId="a"
      address="https://test.preview.example/"
    />,
  );
  fireEvent.click(screen.getByText('Génération et vérification navigateur'));
  expect(screen.getByText('own-copy')).toBeVisible();
  expect(screen.getByText('c'.repeat(40))).toBeVisible();
  fireEvent.click(
    screen.getByRole('button', { name: 'Vérifier dans le navigateur' }),
  );
  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith(
      'https://test.preview.example/.__mergeron_preview/open#fixture',
    ),
  );
  expect(previewsVerify).toHaveBeenCalledWith({
    path: { projectId: 'p', threadId: 'a' },
    throwOnError: true,
    meta: { silent: true },
  });
  vi.mocked(previewsVerify).mockResolvedValue({
    data: {
      url: 'https://other.example/.__mergeron_preview/open#fixture',
      expiresAt: 123,
    },
    response: new Response(),
    request: new Request('https://mergeron.test'),
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Vérifier dans le navigateur' }),
  );
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(replace).toHaveBeenCalledTimes(1);
});
it('keeps an old Manager visibly unverified and prevents opening an inactive preview', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  render(<PreviewReceiptSummary projectId="p" threadId="a" disabled />);
  fireEvent.click(screen.getByText('Génération et vérification navigateur'));
  expect(screen.getByText(/Reçu indisponible/)).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Vérifier dans le navigateur' }),
  ).toBeDisabled();
});
