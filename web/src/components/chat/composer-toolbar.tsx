import type { ReactNode } from 'react';

/** One layout for real composers and browser fixtures, with symmetric row padding. */
export function ComposerToolbar({
  controls,
  children,
}: {
  controls: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 py-1"
      data-composer-toolbar
    >
      <div
        className="flex min-w-0 flex-wrap items-center gap-1"
        data-composer-controls
      >
        {controls}
      </div>
      {children}
    </div>
  );
}
