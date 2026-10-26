import { create } from 'zustand';

export interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
export const usePwaInstall = create<{
  promptEvent: InstallPrompt | null;
  installed: boolean;
}>(() => ({ promptEvent: null, installed: false }));

/** Register before React/auth loading, so an early browser event is retained. */
export function initializePwaInstall() {
  const before = (event: Event) => {
    event.preventDefault();
    usePwaInstall.setState({ promptEvent: event as InstallPrompt });
  };
  const installed = () =>
    usePwaInstall.setState({ promptEvent: null, installed: true });
  usePwaInstall.setState({
    installed: Boolean(
      window.matchMedia?.(
        '(display-mode: standalone), (display-mode: window-controls-overlay)',
      ).matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone,
    ),
  });
  window.addEventListener('beforeinstallprompt', before);
  window.addEventListener('appinstalled', installed);
  return () => {
    window.removeEventListener('beforeinstallprompt', before);
    window.removeEventListener('appinstalled', installed);
  };
}

export async function promptPwaInstall(): Promise<boolean> {
  const event = usePwaInstall.getState().promptEvent;
  if (!event) return false;
  // Browser prompts are single-use, including dismissed prompts.
  usePwaInstall.setState({ promptEvent: null });
  await event.prompt();
  const choice = await event.userChoice;
  if (choice.outcome === 'accepted')
    usePwaInstall.setState({ installed: true });
  return true;
}
