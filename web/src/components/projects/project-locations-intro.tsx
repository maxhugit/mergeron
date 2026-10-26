import { HardDrive, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Presentation only: workspace ids, paths and connection APIs remain unchanged. */
export function ProjectLocationsIntro() {
  const { t } = useTranslation('workspaces');
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="min-w-0 text-muted-foreground">
          {t('managedLocalDescription')}
        </p>
      </div>
      <div>
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <HardDrive className="size-4" />
          {t('localLocations')}
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('localLocationsDescription')}
        </p>
      </div>
    </div>
  );
}
