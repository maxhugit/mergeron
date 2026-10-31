import { expect } from 'vitest';

/** Wait for real modal exit/portal cleanup, without bypassing accessibility. */
export async function waitForDialogClose(
  dialog: HTMLElement,
  container: HTMLElement,
) {
  // Data invalidation or a close click can finish before the exit animation.
  // Poll cheap DOM state until the underlying surface is actually usable.
  await expect
    .poll(
      () => ({
        connected: dialog.isConnected,
        pageHidden: container.hasAttribute('aria-hidden'),
        pointerLocked: document.body.style.pointerEvents === 'none',
        scrollLocked: document.body.hasAttribute('data-scroll-locked'),
      }),
      { timeout: 5000 },
    )
    .toEqual({
      connected: false,
      pageHidden: false,
      pointerLocked: false,
      scrollLocked: false,
    });
}
