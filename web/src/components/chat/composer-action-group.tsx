import type { ReactNode } from 'react';

/** Keep the trailing controls together, including when the toolbar wraps. */
export function ComposerActionGroup({ children }: { children: ReactNode }) {
  return (
    // The toolbar has 8px of bottom padding and none at the top. A 4px
    // optical offset centres these controls in its last row without changing
    // the composer height or its separately managed iOS bottom clearance.
    <div className="relative top-1 ml-auto mr-1 flex shrink-0 items-center gap-2">
      {children}
    </div>
  );
}
