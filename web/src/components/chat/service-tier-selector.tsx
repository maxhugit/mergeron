/**
 * Speed (service tier) selector for the chat input area.
 *
 * Kept separate from the model picker because tiers are an independent axis:
 * they change delivery speed and usage cost, not model behaviour, and a user
 * switching speed should not have to walk past the model and effort lists.
 */
import { ChevronDown, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useActiveModel } from '@/hooks/use-active-model';
import { catalogCopy } from '@/lib/catalog-copy';
import { useModelStore } from '@/stores/model-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { OptionRow } from './option-row';
import { resolveServiceTier } from '@/lib/service-tier';

/** Displays the supported local tier and lets the user explicitly change it. */
export function ServiceTierSelector({
  menuItem = false,
}: {
  menuItem?: boolean;
}) {
  const { t } = useTranslation();
  const serviceTierOverride = useModelStore((s) => s.serviceTierOverride);
  const setServiceTierOverride = useModelStore((s) => s.setServiceTierOverride);
  const selectedThreadId = useTimelineStore((s) => s.threadId);
  const observedTier = useModelStore((s) =>
    selectedThreadId ? s.observedServiceTierByThread[selectedThreadId] : null,
  );
  const { activeModel } = useActiveModel();

  const serviceTiers = activeModel?.serviceTiers ?? [];
  // Lifecycle responses seed this local value. No passive read or complete
  // notification stream exists for service tiers, so unsupported values stay absent.
  const activeTierId = resolveServiceTier(
    serviceTierOverride === null
      ? 'default'
      : (serviceTierOverride ?? observedTier),
    activeModel,
  );
  const activeTier = serviceTiers.find((tier) => tier.id === activeTierId);

  // Keep its place in Capabilities when the catalog is unavailable or the
  // model has no extra tiers. Never invent selectable speed options.
  if (serviceTiers.length === 0)
    return menuItem ? (
      <Button
        variant="ghost"
        size="sm"
        disabled
        className="h-7 w-full justify-start gap-1 rounded-lg px-2 text-xs"
        title={!activeModel ? t('noModelsAvailable') : t('unavailable')}
      >
        <Zap className="h-3.5 w-3.5" />
        <span>
          {t('speed')} · {t('unavailable')}
        </span>
      </Button>
    ) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`h-7 gap-1 rounded-lg px-2 text-xs ${menuItem ? 'w-full justify-start' : ''}`}
          title={t('speed')}
        >
          <Zap className="h-3.5 w-3.5" />
          <span
            className={`${menuItem ? 'inline' : 'hidden sm:inline'} max-w-[150px] truncate`}
          >
            {menuItem && `${t('speed')} · `}
            {activeTier
              ? catalogCopy(activeTier.name)
              : activeTierId === 'default'
                ? t('standard')
                : t('speed')}
          </span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        side="top"
        className="w-72 space-y-1 p-3 text-sm"
      >
        <div className="text-xs font-medium text-muted-foreground">
          {t('speed')}
        </div>
        <OptionRow
          active={activeTierId === 'default'}
          badge={
            activeModel?.defaultServiceTier === null
              ? t('default7505d64a')
              : undefined
          }
          description={t('standardSpeedIncludedWithYourPlan')}
          label={t('standard')}
          // Explicit null, not undefined: this is what clears a tier the
          // thread already carries.
          onSelect={() => setServiceTierOverride(null)}
        />
        {serviceTiers.map((tier) => (
          <OptionRow
            key={tier.id}
            active={tier.id === activeTierId}
            badge={
              tier.id === activeModel?.defaultServiceTier
                ? t('default7505d64a')
                : undefined
            }
            description={catalogCopy(tier.description)}
            label={catalogCopy(tier.name)}
            onSelect={() => setServiceTierOverride(tier.id)}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}
