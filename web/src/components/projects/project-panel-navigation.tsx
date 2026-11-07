import { translationKey } from '@/locales/translation-key';
import { useTranslation } from 'react-i18next';
import { SettingsPanelTabs } from '@/components/settings/settings-panel';

/** A small project-local navigation; fields remain mounted when switching tabs. */
export function ProjectPanelNavigation({
  value,
  items,
  onChange,
  label,
  contentId,
  namespace = 'common',
}: {
  value: string;
  items: readonly { id: string; label: string }[];
  onChange: (value: string) => void;
  label: string;
  contentId: string;
  namespace?: 'common' | 'previews';
}) {
  const { t } = useTranslation(namespace);
  return (
    <SettingsPanelTabs
      label={label}
      value={value}
      items={items.map((item) => ({
        ...item,
        label: t(translationKey(item.label)),
      }))}
      onChange={onChange}
      contentId={contentId}
    />
  );
}
