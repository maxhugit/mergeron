import { translationKey } from '@/locales/translation-key';
/** Reusable editor for a single runtime setting with Save/Reset actions. */
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  settingLabel,
  sourceLabel,
  sourceVariant,
  formatSettingValue,
  type RuntimeSetting,
} from './setting-helpers';

interface Props {
  setting: RuntimeSetting;
  draft: string;
  disabled: boolean;
  onDraftChange: (key: string, value: string) => void;
  onSave?: (setting: RuntimeSetting) => void;
  onReset: (key: string) => void;
}

export function SettingEditor({
  setting,
  draft,
  disabled,
  onDraftChange,
  onSave,
  onReset,
}: Props) {
  const { t } = useTranslation();
  const isDbOverride = setting.source === 'db';

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card/50 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">
              {t(translationKey(settingLabel(setting.key)))}
            </h3>
            <Badge variant={sourceVariant(setting.source)}>
              {t(translationKey(sourceLabel(setting.source)))}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(translationKey(setting.description))}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('default')}: {formatSettingValue(setting.defaultValue)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {setting.type === 'boolean' ? (
          <input
            type="checkbox"
            role="switch"
            aria-label={t(translationKey(settingLabel(setting.key)))}
            checked={draft === 'true'}
            disabled={disabled}
            onChange={(event) =>
              onDraftChange(setting.key, String(event.target.checked))
            }
            className="h-4 w-4 accent-primary"
          />
        ) : setting.type === 'number' ? (
          <Input
            type="number"
            value={draft}
            min={setting.constraints.min}
            max={setting.constraints.max}
            step={setting.constraints.integer ? 1 : undefined}
            disabled={disabled}
            onChange={(e) => onDraftChange(setting.key, e.target.value)}
            className="h-8 w-40"
          />
        ) : (
          <Input
            value={draft}
            disabled={disabled}
            onChange={(e) => onDraftChange(setting.key, e.target.value)}
            className="h-8 w-64"
          />
        )}

        {onSave && (
          <Button
            size="sm"
            className="h-8"
            disabled={disabled}
            onClick={() => onSave(setting)}
          >
            {t('save')}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={disabled || !isDbOverride}
          onClick={() => onReset(setting.key)}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('reset')}
        </Button>
      </div>
    </div>
  );
}
