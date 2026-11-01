import type { ReactNode } from 'react';

/** Keep the trailing controls together, including when the toolbar wraps. */
export function ComposerActionGroup({ children }: { children: ReactNode }) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 @min-[480px]/composer:gap-2">
      {children}
    </div>
  );
}
