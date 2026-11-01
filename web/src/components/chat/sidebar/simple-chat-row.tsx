import { useDraggable } from '@dnd-kit/react';
import { Feedback } from '@dnd-kit/dom';
import {
  GripVertical,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { SimpleChatThreadSummary } from '@/lib/simple-chat-api';
import { cn } from '@/lib/utils';

interface Props {
  thread: SimpleChatThreadSummary;
  isActive: boolean;
  disabled: boolean;
  running?: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function SimpleChatRow({
  thread,
  isActive,
  disabled,
  running = false,
  onOpen,
  onRename,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const { ref, handleRef, isDragging } = useDraggable({
    id: `simple-chat-${thread.id}`,
    disabled,
    data: {
      kind: 'simple-chat',
      threadId: thread.id,
      projectId: thread.projectId,
      sidebarItemId: `simple:${thread.id}`,
    },
    plugins: [Feedback.configure({ feedback: 'clone' })],
  });

  return (
    <div
      ref={ref}
      className={cn(
        'group flex items-center gap-0.5 pl-3',
        isDragging && 'opacity-40',
      )}
    >
      <button
        ref={handleRef}
        type="button"
        disabled={disabled}
        className="touch-none cursor-grab rounded p-0.5 text-muted-foreground/50 hover:bg-accent/50 hover:text-foreground active:cursor-grabbing disabled:cursor-not-allowed"
        aria-label={t('moveConversation')}
        title={t('moveConversation')}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-xs transition-colors',
          isActive
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )}
        title={thread.title}
      >
        {running ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <MessageCircle className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{thread.title}</span>
      </button>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="hover-reveal h-6 w-6 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={`${t('actionsFor')} ${thread.title}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-44 p-1">
          <Button
            variant="ghost"
            className="h-7 w-full justify-start gap-2 px-2 text-xs"
            onClick={onRename}
          >
            <Pencil className="h-3.5 w-3.5" />
            {t('rename')}
          </Button>
          <Button
            variant="ghost"
            className="h-7 w-full justify-start gap-2 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('delete')}
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
