/**
 * Right-click context menu for file tree entries.
 * Actions vary based on whether the target is a file or directory.
 */
import { useDeferredMenuAction } from '@/hooks/use-deferred-menu-action';
import type { ComponentProps } from 'react';
import { DeliverableDocuments } from '@/components/projects/deliverable-documents';
import { showSnackbar } from '@/stores/snackbar-store';
import { FileActionsMenu, type FileMenuAction } from './file-actions-menu';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  Download,
  FilePlus,
  FolderPlus,
  FolderUp,
  GitBranch,
  MessageSquarePlus,
  Move,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

export interface FileContextMenuActions {
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onRename?: () => void;
  onCopy?: () => void;
  onMove?: () => void;
  onDelete?: () => void;
  onRefresh?: () => void;
  onDownload?: () => void;
  onUploadFiles?: () => void;
  onUploadFolder?: () => void;
  onAttachToChat?: () => void;
}
export interface FileExtraAction {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface FileContextMenuProps {
  type: 'file' | 'directory';
  actions: FileContextMenuActions;
  /** Called when context menu open state changes — for highlighting the target row. */
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  documentActions?: DeliverableContextActions;
  extraActions?: FileExtraAction[];
  label?: string;
}

export type DeliverableContextActions = Omit<
  ComponentProps<typeof DeliverableDocuments>,
  'children' | 'onError'
>;

export function FileContextMenu({
  type,
  actions,
  onOpenChange,
  children,
  documentActions,
  extraActions = [],
  label,
}: FileContextMenuProps) {
  const { t } = useTranslation();
  const { select, afterClose } = useDeferredMenuAction();
  const isDir = type === 'directory';

  if (documentActions)
    return (
      <DeliverableDocuments
        {...documentActions}
        onAttachToChat={actions.onAttachToChat}
        extraActions={extraActions}
        menuLabel={label}
        onError={() => showSnackbar(t('unableToUpdateDocument'), 'error')}
      >
        {children}
      </DeliverableDocuments>
    );

  if (!isDir) {
    const items: FileMenuAction[] = [];
    const add = (
      id: string,
      label: string,
      icon: FileMenuAction['icon'],
      onSelect?: () => void,
      separated = false,
      destructive = false,
    ) => {
      if (onSelect)
        items.push({ id, label, icon, onSelect, separated, destructive });
    };
    add('rename', t('rename'), Pencil, actions.onRename);
    add('copy', t('copyTo'), Copy, actions.onCopy);
    add('move', t('moveTo'), Move, actions.onMove);
    add('download', t('download'), Download, actions.onDownload);
    add('refresh', t('refresh'), RefreshCw, actions.onRefresh, true);
    items.push(
      ...extraActions.map((action, index) => ({
        id: `git:${action.label}`,
        label: action.label,
        icon: GitBranch,
        disabled: action.disabled,
        onSelect: action.onSelect,
        separated: index === 0,
      })),
    );
    add(
      'attach',
      t('attachToChat'),
      MessageSquarePlus,
      actions.onAttachToChat,
      true,
    );
    add('delete', t('delete'), Trash2, actions.onDelete, true, true);
    return (
      <FileActionsMenu
        actions={items}
        onOpenChange={onOpenChange}
        buttonLabel={label}
      >
        {children}
      </FileActionsMenu>
    );
  }

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48" onCloseAutoFocus={afterClose}>
        {extraActions.map((action) => (
          <ContextMenuItem
            key={action.label}
            disabled={action.disabled}
            onSelect={() => select(action.onSelect)}
          >
            {action.label}
          </ContextMenuItem>
        ))}
        {isDir && (actions.onNewFile || actions.onNewFolder) && (
          <>
            {actions.onNewFile && (
              <ContextMenuItem onSelect={() => select(actions.onNewFile)}>
                <FilePlus className="h-3.5 w-3.5" />
                {t('newFile')}
              </ContextMenuItem>
            )}
            {actions.onNewFolder && (
              <ContextMenuItem onSelect={() => select(actions.onNewFolder)}>
                <FolderPlus className="h-3.5 w-3.5" />
                {t('newFolder')}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
          </>
        )}
        {actions.onRename && (
          <ContextMenuItem onSelect={() => select(actions.onRename)}>
            <Pencil className="h-3.5 w-3.5" />
            {t('rename')}
          </ContextMenuItem>
        )}
        {actions.onCopy && (
          <ContextMenuItem onSelect={() => select(actions.onCopy)}>
            <Copy className="h-3.5 w-3.5" />
            {t('copyTo')}
          </ContextMenuItem>
        )}
        {actions.onMove && (
          <ContextMenuItem onSelect={() => select(actions.onMove)}>
            <Move className="h-3.5 w-3.5" />
            {t('moveTo')}
          </ContextMenuItem>
        )}
        {!isDir && actions.onDownload && (
          <ContextMenuItem onSelect={() => select(actions.onDownload)}>
            <Download className="h-3.5 w-3.5" />
            {t('download')}
          </ContextMenuItem>
        )}
        {isDir && (actions.onUploadFiles || actions.onUploadFolder) && (
          <>
            <ContextMenuSeparator />
            {actions.onUploadFiles && (
              <ContextMenuItem onSelect={() => select(actions.onUploadFiles)}>
                <Upload className="h-3.5 w-3.5" />
                {t('uploadFilesHere')}
              </ContextMenuItem>
            )}
            {actions.onUploadFolder && (
              <ContextMenuItem onSelect={() => select(actions.onUploadFolder)}>
                <FolderUp className="h-3.5 w-3.5" />
                {t('uploadFolderHere')}
              </ContextMenuItem>
            )}
          </>
        )}
        {actions.onRefresh && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => select(actions.onRefresh)}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('refresh')}
            </ContextMenuItem>
          </>
        )}
        {actions.onAttachToChat && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => select(actions.onAttachToChat)}>
              <MessageSquarePlus className="h-3.5 w-3.5" />
              {t('attachToChat')}
            </ContextMenuItem>
            {!actions.onDelete && <ContextMenuSeparator />}
          </>
        )}
        {actions.onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={() => select(actions.onDelete)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('delete')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Context menu for unused listing space, whose actions target the current directory. */
export function FileListingContextMenu({
  actions,
  children,
}: {
  actions: Pick<
    FileContextMenuActions,
    | 'onNewFile'
    | 'onNewFolder'
    | 'onUploadFiles'
    | 'onUploadFolder'
    | 'onRefresh'
  >;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { select, afterClose } = useDeferredMenuAction();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48" onCloseAutoFocus={afterClose}>
        {actions.onNewFile && (
          <ContextMenuItem onSelect={() => select(actions.onNewFile)}>
            <FilePlus className="h-3.5 w-3.5" />
            {t('newFile')}
          </ContextMenuItem>
        )}
        {actions.onNewFolder && (
          <ContextMenuItem onSelect={() => select(actions.onNewFolder)}>
            <FolderPlus className="h-3.5 w-3.5" />
            {t('newFolder')}
          </ContextMenuItem>
        )}
        {(actions.onNewFile || actions.onNewFolder) && <ContextMenuSeparator />}
        {actions.onUploadFiles && (
          <ContextMenuItem onSelect={() => select(actions.onUploadFiles)}>
            <Upload className="h-3.5 w-3.5" />
            {t('uploadFilesHere')}
          </ContextMenuItem>
        )}
        {actions.onUploadFolder && (
          <ContextMenuItem onSelect={() => select(actions.onUploadFolder)}>
            <FolderUp className="h-3.5 w-3.5" />
            {t('uploadFolderHere')}
          </ContextMenuItem>
        )}
        {actions.onRefresh && (
          <ContextMenuItem onSelect={() => select(actions.onRefresh)}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t('refresh')}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
