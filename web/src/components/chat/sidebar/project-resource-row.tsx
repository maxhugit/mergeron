import {
  GripVertical,
  ListTodo,
  MoreHorizontal,
  Pencil,
  Trash2,
  Zap,
  Package,
} from 'lucide-react';
import { Feedback } from '@dnd-kit/dom';
import { useDraggable } from '@dnd-kit/react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { ProjectResourceSummary } from '@/lib/projects-api';
import { cn } from '@/lib/utils';

interface Props {
  resource: ProjectResourceSummary;
  active: boolean;
  pending: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function ProjectResourceRow({
  resource,
  active,
  pending,
  onOpen,
  onRename,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const { ref, handleRef, isDragging } = useDraggable({
    id: `project-resource-${resource.id}`,
    disabled: pending,
    data: {
      kind: 'project-resource',
      resourceId: resource.id,
      projectId: resource.projectId,
      sidebarItemId: `resource:${resource.id}`,
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
        disabled={pending}
        className="touch-none cursor-grab rounded p-0.5 text-muted-foreground/50 hover:bg-accent/50 hover:text-foreground active:cursor-grabbing disabled:cursor-not-allowed"
        aria-label={t('moveProjectEntry', { name: resource.name })}
        title={t('moveProjectEntry', { name: resource.name })}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={cn(
          'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
          active
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )}
        onClick={onOpen}
        title={resource.name}
      >
        {resource.type === 'deliverable_board' ? (
          <Package className="h-3 w-3 shrink-0" />
        ) : resource.type === 'automation_board' ? (
          <Zap className="h-3 w-3 shrink-0" />
        ) : (
          <ListTodo className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{resource.name}</span>
      </button>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="hover-reveal h-6 w-6 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={`${t('actionsFor')} ${resource.name}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-44 p-1">
          <Button
            variant="ghost"
            className="h-7 w-full justify-start gap-2 px-2 text-xs"
            disabled={pending}
            onClick={onRename}
          >
            <Pencil className="h-3.5 w-3.5" />
            {t('rename')}
          </Button>
          <Button
            variant="ghost"
            className="h-7 w-full justify-start gap-2 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={pending}
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
