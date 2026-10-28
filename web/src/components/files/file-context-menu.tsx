/**
 * Right-click context menu for file tree entries.
 * Actions vary based on whether the target is a file or directory.
 */
import { useDeferredMenuAction } from '@/hooks/use-deferred-menu-action';
import { WorkspaceEntryMenu } from '@/components/chat/workspace-entry-menu';
import type { ComponentProps } from 'react';
import { DeliverableDocuments } from '@/components/projects/deliverable-documents';
import { showSnackbar } from '@/stores/snackbar-store';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  Download,
  FilePlus,
  FolderPlus,
  FolderUp,
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
  dropdown?: boolean;
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
  dropdown = false,
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
        dropdown={dropdown}
        menuLabel={label}
        onError={() => showSnackbar(t('unableToUpdateDocument'), 'error')}
      >
        {children}
      </DeliverableDocuments>
    );

  if (dropdown) {
    const items = [
      [t('newFile'), isDir ? actions.onNewFile : undefined],
      [t('newFolder'), isDir ? actions.onNewFolder : undefined],
      [t('rename'), actions.onRename],
      [t('copyTo'), actions.onCopy],
      [t('moveTo'), actions.onMove],
      [t('download'), !isDir ? actions.onDownload : undefined],
      [t('uploadFilesHere'), isDir ? actions.onUploadFiles : undefined],
      [t('uploadFolderHere'), isDir ? actions.onUploadFolder : undefined],
      [t('attachToChat'), actions.onAttachToChat],
      [t('refresh'), actions.onRefresh],
      [t('delete'), actions.onDelete],
    ] as const;
    return (
      <WorkspaceEntryMenu
        label={label ?? t('actions')}
        onCloseAutoFocus={afterClose}
        items={[
          ...items
            .filter(([, action]) => action)
            .map(([label, action]) => ({
              label,
              destructive: action === actions.onDelete,
              onSelect: () => select(action),
            })),
          ...extraActions.map((action) => ({
            ...action,
            onSelect: () => select(action.onSelect),
          })),
        ]}
      />
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
        {actions.onAttachToChat && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => select(actions.onAttachToChat)}>
              <MessageSquarePlus className="h-3.5 w-3.5" />
              {t('attachToChat')}
            </ContextMenuItem>
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
