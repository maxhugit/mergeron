import { translationKey } from '@/locales/translation-key';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { appRuntimeState } from './integration-runtime-state';

export function AppRuntimeBadges({
  observed,
  enabled,
  callable,
}: {
  observed: boolean;
  enabled: boolean;
  callable: boolean;
}) {
  const { t } = useTranslation('integrations');
  return (
    <>
      <Badge variant="outline" className="text-[10px]">
        {t('viaOpenAI')}
      </Badge>
      <Badge
        variant={observed && enabled && callable ? 'secondary' : 'outline'}
        className="text-[10px]"
      >
        {t(translationKey(appRuntimeState(observed, enabled, callable)))}
      </Badge>
    </>
  );
}
