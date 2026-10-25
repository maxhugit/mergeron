import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';

export function TaskDetailSurface({
  open,
  embedded,
  onClose,
  title,
  children,
}: {
  open: boolean;
  embedded: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  const content = (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b px-6 py-4">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Retour"
          onClick={onClose}
        >
          <ArrowLeft />
        </Button>
        <h2
          id="task-detail-title"
          className="min-w-0 truncate text-lg font-semibold"
        >
          {title}
        </h2>
      </header>
      {children}
    </>
  );
  // Context links still request an overlay; the task manager itself uses a page.
  if (embedded)
    return (
      <Dialog
        open
        onOpenChange={(value) => {
          if (!value) onClose();
        }}
      >
        <DialogContent
          aria-labelledby="task-detail-title"
          className="flex max-h-[92vh] flex-col overflow-hidden p-0 sm:max-w-2xl"
        >
          {content}
        </DialogContent>
      </Dialog>
    );
  return (
    <section
      aria-labelledby="task-detail-title"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {content}
    </section>
  );
}
