import { DropdownMenu } from 'radix-ui';
import {
  Plus,
  FolderPlus,
  Upload,
  ChevronsDownUp,
  ChevronsUpDown,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function ProjectsMenu({
  onCreate,
  onImport,
  onCollapse,
  onExpand,
  canImport,
}: {
  onCreate: () => void;
  onImport: () => void;
  onCollapse: () => void;
  onExpand: () => void;
  canImport: boolean;
}) {
  const { t } = useTranslation('workspaces');
  const actions = [
    { label: t('projectsCreate'), icon: FolderPlus, run: onCreate },
    {
      label: t('projectsImport'),
      icon: Upload,
      run: onImport,
      disabled: !canImport,
    },
    { label: t('projectsCollapse'), icon: ChevronsDownUp, run: onCollapse },
    { label: t('projectsExpand'), icon: ChevronsUpDown, run: onExpand },
  ];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label={t('projectsMenu')}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {actions.map(({ label, icon: Icon, run, disabled }) => (
            <DropdownMenu.Item
              key={label}
              disabled={disabled}
              onSelect={run}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs outline-none data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
