import { useRef } from 'react';

/** Open dialogs/editors after Radix has closed and restored menu focus. */
export function useDeferredMenuAction() {
  const pending = useRef<(() => void) | null>(null);
  return {
    select(action: (() => void) | undefined) {
      pending.current = action ?? null;
    },
    afterClose(event: Event) {
      const action = pending.current;
      pending.current = null;
      if (!action) return;
      event.preventDefault();
      requestAnimationFrame(action);
    },
  };
}
