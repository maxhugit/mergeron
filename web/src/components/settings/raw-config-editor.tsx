/**
 * Direct config.toml editor.
 *
 * Deliberately independent of the structured config query. A malformed or
 * unreadable config is exactly when this is needed, and that is also when
 * `config/read` fails — rendering it only on the success path put the repair
 * tool behind the failure it repairs.
 */
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import Editor, { type OnMount } from '@monaco-editor/react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { SettingsSaveBar } from './settings-save-bar';
import { useThemeStore } from '@/stores/theme-store';
import { showSnackbar } from '@/stores/snackbar-store';
import { getApiErrorMessage } from '@/lib/api-error';
import {
  codexConfigReadRawConfigOptions,
  codexConfigUpdateRawConfigMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import type { CatalogWarningDto } from '@/generated/api';

export function RawConfigEditor({
  onSaved,
  active = true,
}: {
  onSaved?: () => void;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const dark = useThemeStore((s) => s.dark);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  /** Exact text last read from the server; the write precondition. */
  const [baseline, setBaseline] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<CatalogWarningDto[]>([]);
  const [restartRequired, setRestartRequired] = useState(false);
  const monacoRef = useRef<Parameters<OnMount>[0] | null>(null);

  const rawQuery = useQuery({
    ...codexConfigReadRawConfigOptions(),
    enabled: false,
  });

  const handleMount: OnMount = useCallback((editor) => {
    monacoRef.current = editor;
  }, []);

  const handleExpand = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (!next) return;
    void rawQuery.refetch().then((result) => {
      if (!result.data) return;
      setDraft(result.data.content);
      setBaseline(result.data.content);
    });
  }, [expanded, rawQuery]);

  const mutation = useMutation({
    ...codexConfigUpdateRawConfigMutation(),
    onSuccess: (data, variables) => {
      // The saved text becomes the next precondition; re-reading would race a
      // concurrent edit into the baseline without the user ever seeing it.
      setBaseline(variables.body.content);
      setWarnings(data.warnings);
      setRestartRequired(data.restartRequired);
      // `reloaded` and `restartRequired` are the whole point of the response:
      // announcing a reload that did not happen sends the user off to debug a
      // setting that is written but not in effect.
      showSnackbar(
        data.reloaded
          ? t('configFileSavedAndReloaded')
          : data.restartRequired
            ? t('configFileSavedCodexMustRestartForItToTakeEffect')
            : t('configFileSavedButCodexDidNotReloadIt'),
        data.reloaded ? 'success' : 'info',
      );
      onSaved?.();
    },
    onError: (err) => {
      showSnackbar(
        t('failedToSaveConfigFileMsg', {
          msg: getApiErrorMessage(err),
        }),
        'error',
      );
    },
  });

  const dirty = baseline !== null && draft !== baseline;

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <button
        type="button"
        onClick={handleExpand}
        className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        <FileText className="h-4 w-4" />
        {t('editConfigToml')}
        {rawQuery.data?.filePath && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            ({rawQuery.data.filePath})
          </span>
        )}
      </button>

      {expanded && (
        <div className="space-y-2">
          <div className="overflow-hidden rounded-md border border-border">
            <Editor
              value={draft}
              language="ini"
              theme={dark ? 'vs-dark' : 'vs'}
              height="400px"
              onMount={handleMount}
              onChange={(value) => setDraft(value ?? '')}
              options={{
                readOnly: mutation.isPending,
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                padding: { top: 8 },
              }}
            />
          </div>

          {warnings.length > 0 && (
            <ul className="space-y-1 text-xs text-amber-500">
              {warnings.map((warning, index) => (
                <li key={index}>
                  {warning.model ? `${warning.model}: ` : ''}
                  {warning.message}
                </li>
              ))}
            </ul>
          )}
          {restartRequired && (
            <p className="text-xs text-amber-500">
              {t(
                'thisChangeOnlyTakesEffectAfterCodexRestartsUseRestartCodexInTheModelCatalogSectionBelow',
              )}
            </p>
          )}

          <SettingsSaveBar
            active={active}
            dirty={dirty}
            saving={mutation.isPending}
            label="Save & Reload"
            onSave={() => {
              const content = monacoRef.current?.getValue() ?? draft;
              mutation.mutate({
                body: { content, expectedContent: baseline ?? undefined },
              });
            }}
          />
        </div>
      )}
    </div>
  );
}
