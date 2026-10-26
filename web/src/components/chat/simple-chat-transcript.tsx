import type { ReactNode, Ref } from 'react';
import { cn } from '@/lib/utils';

/** Same vertical scroll box / width-constrained content policy as VirtualTranscript. */
export function SimpleChatTranscript({
  children,
  scrollRef,
}: {
  children: ReactNode;
  scrollRef: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={scrollRef}
      data-simple-chat-scroller
      className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-5 [scrollbar-gutter:stable]"
    >
      <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 overflow-x-hidden [overflow-wrap:anywhere]">
        {children}
      </div>
    </div>
  );
}

export function SimpleChatBubble({
  children,
  role,
}: {
  children: ReactNode;
  role: 'user' | 'assistant';
}) {
  return (
    <article
      className={cn(
        'min-w-0 max-w-[92%] rounded-2xl px-4 py-3 text-sm',
        role === 'user'
          ? 'ml-auto bg-primary text-primary-foreground'
          : 'mr-auto border bg-card text-card-foreground',
      )}
    >
      {children}
    </article>
  );
}
