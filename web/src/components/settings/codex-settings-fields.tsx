import { useContext } from 'react';
import { SettingsPanelContext } from './settings-panel-context';
import { translationKey } from '@/locales/translation-key';
/** Row editor for structured Codex config settings. */
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ConfigSourceBadge } from '@/components/codex-config/config-override-controls';
import type { ConfigEditDto } from '@/generated/api/types.gen';
import { cn } from '@/lib/utils';
import type { FieldDef } from './codex-settings-defs';

/** Props for one structured config field editor row. */
export interface FieldEditorProps {
  /** Field definition to render. */
  def: FieldDef;
  /** Current draft string. */
  draft: string;
  /** Whether the draft differs from the latest config/read value. */
  dirty: boolean;
  /** Source layer label for the effective value. */
  origin: string | null;
  /** Whether this key path is currently set in user config. */
  overridden: boolean;
  /** Disables edits while writes are pending. */
  saving: boolean;
  /** Dynamic profile names, used only by the profile selector. */
  profileOptions?: string[];
  /** Dynamic service tier ids, used only by the service tier selector. */
  serviceTierOptions?: string[];
  modelOptions?: string[];
  dynamicOptions?: string[];
  /** Batch-mode parent owns saving. */
  batch?: boolean;
  /** Updates the local draft for a key path. */
  onDraftChange: (key: string, value: string) => void;
  /** Saves the current draft as a concrete override. */
  onSave: (key: ConfigEditDto['keyPath']) => void;
  /** Clears this leaf key back to inherited behavior. */
  onClear: (key: ConfigEditDto['keyPath']) => void;
}

/** Per-field editor row with an explicit clear-to-inherit action. */
export function ConfigFieldEditor({
  def,
  draft,
  dirty,
  origin,
  overridden,
  saving,
  profileOptions,
  serviceTierOptions,
  modelOptions,
  dynamicOptions,
  batch = false,
  onDraftChange,
  onSave,
  onClear,
}: FieldEditorProps) {
  const embedded = useContext(SettingsPanelContext);
  const { t, i18n } = useTranslation();
  const isNonEnglish = !i18n.language.startsWith('en');

  // `profile` and `service_tier` are both runtime-discovered rather than
  // statically enumerable, so they arrive as props instead of on the field def.
  const options =
    def.key === 'profile'
      ? (profileOptions ?? [])
      : def.key === 'service_tier'
        ? (serviceTierOptions ?? [])
        : (dynamicOptions ?? def.options ?? []);
  const visibleOptions =
    draft && !options.includes(draft) ? [...options, draft] : options;

  return (
    <div
      className={
        embedded
          ? 'min-w-0 space-y-2 border-b border-border pb-4 last:border-0'
          : 'min-w-0 space-y-2 rounded-lg border border-border bg-card/50 px-4 py-3'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={`codex-field-${def.key}`}
          className="text-sm font-medium"
        >
          {t(translationKey(def.label))}
        </label>
        {isNonEnglish && (
          <code className="break-all text-xs text-muted-foreground">
            {def.key}
          </code>
        )}
        <ConfigSourceBadge source={origin} />
      </div>
      {def.description && (
        <p className="text-xs text-muted-foreground">
          {t(translationKey(def.description))}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        {def.control === 'select' ? (
          <select
            id={`codex-field-${def.key}`}
            value={draft}
            onChange={(e) => onDraftChange(def.key, e.target.value)}
            disabled={saving}
            className={cn(
              'h-8 max-w-full rounded-md border border-input bg-background px-3 text-sm',
              'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
            )}
          >
            <option value="" disabled>
              {t('notSet')}
            </option>
            {visibleOptions.map((opt) => (
              <option key={opt} value={opt}>
                {t(translationKey(opt))}
              </option>
            ))}
          </select>
        ) : modelOptions ? (
          <div className="w-full space-y-2">
            <select
              id={`codex-field-${def.key}`}
              value={modelOptions.includes(draft) ? draft : '__custom__'}
              disabled={saving}
              onChange={(event) =>
                onDraftChange(
                  def.key,
                  event.target.value === '__custom__' ? '' : event.target.value,
                )
              }
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
              <option value="__custom__">
                {t(
                  translationKey(
                    def.key === 'model_provider'
                      ? 'customProvider'
                      : 'customModel',
                  ),
                )}
              </option>
            </select>
            {!modelOptions.includes(draft) && (
              <Input
                aria-label={t(
                  translationKey(
                    def.key === 'model_provider'
                      ? 'customProvider'
                      : 'customModel',
                  ),
                )}
                value={draft}
                disabled={saving}
                placeholder={t(
                  translationKey(
                    def.key === 'model_provider'
                      ? 'providerIdentifier'
                      : 'modelIdentifier',
                  ),
                )}
                onChange={(event) => onDraftChange(def.key, event.target.value)}
              />
            )}
          </div>
        ) : def.control === 'textarea' ? (
          <Textarea
            id={`codex-field-${def.key}`}
            value={draft}
            onChange={(e) => onDraftChange(def.key, e.target.value)}
            disabled={saving}
            className="min-h-[80px] w-full font-mono text-xs"
            spellCheck={false}
          />
        ) : def.control === 'number' ? (
          <Input
            id={`codex-field-${def.key}`}
            type="number"
            value={draft}
            onChange={(e) => onDraftChange(def.key, e.target.value)}
            disabled={saving}
            className="h-8 w-full max-w-48"
            min={0}
          />
        ) : (
          <Input
            id={`codex-field-${def.key}`}
            value={draft}
            onChange={(e) => onDraftChange(def.key, e.target.value)}
            disabled={saving}
            className="h-8 w-full max-w-64"
          />
        )}

        {!batch && (
          <Button
            size="sm"
            className="h-8"
            disabled={saving || !dirty}
            onClick={() => onSave(def.key)}
          >
            {t('save')}
          </Button>
        )}
        {overridden && (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={saving}
            onClick={() => onClear(def.key)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('returnToInheritance')}
          </Button>
        )}
      </div>
    </div>
  );
}
