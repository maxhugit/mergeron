import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VoiceDictationButton } from './voice-dictation-button';
import { dictationBackend, startCliDictation } from '@/lib/cli-dictation';

vi.mock('@/lib/cli-dictation', () => ({
  dictationBackend: vi.fn(),
  startCliDictation: vi.fn(),
}));
vi.mock('@/stores/snackbar-store', () => ({ showSnackbar: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
  vi.mocked(dictationBackend).mockResolvedValue('codex');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('uses the native CLI handle and adds text to the draft only after explicit stop', async () => {
  const finish = vi.fn(async () => 'Texte dicté');
  const cancel = vi.fn(async () => {});
  vi.mocked(startCliDictation).mockResolvedValue({ finish, cancel });
  const onTranscript = vi.fn();
  render(<VoiceDictationButton onTranscript={onTranscript} />);
  fireEvent.click(screen.getByRole('button', { name: 'Démarrer la dictée' }));
  await screen.findByRole('button', { name: 'Arrêter la dictée' });
  expect(onTranscript).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Arrêter la dictée' }));
  await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Texte dicté'));
  expect(finish).toHaveBeenCalledTimes(1);
});

it('aborts and cancels when leaving the conversation, without emitting a transcript', async () => {
  const cancel = vi.fn(async () => {});
  vi.mocked(startCliDictation).mockResolvedValue({ finish: vi.fn(), cancel });
  const onTranscript = vi.fn();
  const view = render(<VoiceDictationButton onTranscript={onTranscript} />);
  fireEvent.click(screen.getByRole('button', { name: 'Démarrer la dictée' }));
  await screen.findByRole('button', { name: 'Arrêter la dictée' });
  const signal = vi.mocked(startCliDictation).mock.calls[0][0];
  view.unmount();
  expect(signal.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(onTranscript).not.toHaveBeenCalled();
});

it('cancels a retained but hidden conversation and resets on reactivation', async () => {
  const cancel = vi.fn(async () => {});
  const finish = vi.fn();
  vi.mocked(startCliDictation).mockResolvedValue({ finish, cancel });
  const onTranscript = vi.fn();
  const view = render(
    <VoiceDictationButton active onTranscript={onTranscript} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Démarrer la dictée' }));
  await screen.findByRole('button', { name: 'Arrêter la dictée' });
  const signal = vi.mocked(startCliDictation).mock.calls[0][0];
  view.rerender(
    <VoiceDictationButton active={false} onTranscript={onTranscript} />,
  );
  expect(signal.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(finish).not.toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: 'Démarrer la dictée' }),
  ).toBeDisabled();
  view.rerender(<VoiceDictationButton active onTranscript={onTranscript} />);
  expect(
    screen.getByRole('button', { name: 'Démarrer la dictée' }),
  ).toBeEnabled();
});

it('does not insert a late finish response into a hidden conversation', async () => {
  let resolve!: (text: string) => void;
  const finish = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  vi.mocked(startCliDictation).mockResolvedValue({
    finish,
    cancel: vi.fn(async () => {}),
  });
  const onTranscript = vi.fn();
  const view = render(
    <VoiceDictationButton active onTranscript={onTranscript} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Démarrer la dictée' }));
  await screen.findByRole('button', { name: 'Arrêter la dictée' });
  fireEvent.click(screen.getByRole('button', { name: 'Arrêter la dictée' }));
  view.rerender(
    <VoiceDictationButton active={false} onTranscript={onTranscript} />,
  );
  resolve('Texte tardif');
  await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
  expect(onTranscript).not.toHaveBeenCalled();
});
