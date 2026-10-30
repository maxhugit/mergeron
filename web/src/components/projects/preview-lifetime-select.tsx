import { useTranslation } from 'react-i18next';

const choices = [60, 180, 300, 600, 1440] as const;
export function PreviewLifetimeSelect({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('previews');
  return (
    <label className="grid min-w-0 gap-1 text-sm">
      {t('lifetime')}
      <select
        className="min-w-0 rounded border bg-background p-2"
        value={value === null ? 'never' : String(value)}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            event.target.value === 'never' ? null : Number(event.target.value),
          )
        }
      >
        {value !== null && !choices.some((choice) => choice === value) && (
          <option value={value} disabled>
            {t('legacyLifetime', { minutes: value })}
          </option>
        )}
        {choices.map((minutes) => (
          <option key={minutes} value={minutes}>
            {t('lifetimeHours', { count: minutes / 60 })}
          </option>
        ))}
        <option value="never">{t('never')}</option>
      </select>
    </label>
  );
}
