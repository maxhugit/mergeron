import { useState, type ReactNode } from 'react';
import { ExpandedTechnicalDetails } from '@/lib/technical-display';

export function TechnicalDetails({
  label,
  expanded = false,
  children,
}: {
  label: string;
  expanded?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(expanded);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-lg border border-border/50 p-2 text-sm"
    >
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {label}
      </summary>
      {open && (
        <ExpandedTechnicalDetails.Provider value={true}>
          <div className="mt-2 space-y-2">{children}</div>
        </ExpandedTechnicalDetails.Provider>
      )}
    </details>
  );
}
