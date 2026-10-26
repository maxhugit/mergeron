import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  initializePwaInstall,
  promptPwaInstall,
  usePwaInstall,
  type InstallPrompt,
} from './pwa-install';
let cleanup: () => void;
beforeEach(() => {
  usePwaInstall.setState({ installed: false, promptEvent: null });
  cleanup = initializePwaInstall();
});
afterEach(() => cleanup());
it('retains the browser prompt until a user action, then consumes it once', async () => {
  const event = new Event('beforeinstallprompt', {
    cancelable: true,
  }) as InstallPrompt;
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(event.prompt).not.toHaveBeenCalled();
  expect(await promptPwaInstall()).toBe(true);
  expect(event.prompt).toHaveBeenCalledOnce();
  expect(usePwaInstall.getState().installed).toBe(true);
  expect(await promptPwaInstall()).toBe(false);
});
it('does not claim installation when the prompt is dismissed', async () => {
  const event = new Event('beforeinstallprompt') as InstallPrompt;
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome: 'dismissed' });
  window.dispatchEvent(event);
  await promptPwaInstall();
  expect(usePwaInstall.getState()).toMatchObject({
    installed: false,
    promptEvent: null,
  });
  window.dispatchEvent(new Event('appinstalled'));
  expect(usePwaInstall.getState().installed).toBe(true);
});
