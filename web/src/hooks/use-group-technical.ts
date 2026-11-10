import { useEffect } from 'react';
import { create } from 'zustand';
import { usePlatformSession } from '@/lib/platform-session';
import { useSidebarPreferences } from './use-sidebar-preferences';

export const useTechnicalGrouping = create<{ grouped: boolean }>(() => ({
  grouped: false,
}));

/** Personal presentation only, shared across the profile's conversations. */
export function useGroupTechnical() {
  const { data } = usePlatformSession();
  const preference = useSidebarPreferences(data?.personId, 'conversation');
  const grouped = preference.values['open:group-technical'] === true;
  useEffect(() => {
    useTechnicalGrouping.setState({ grouped });
  }, [data?.personId, grouped]);
  return {
    ...preference,
    grouped: preference.values['open:group-technical'] === true,
    toggle: () =>
      preference.set(
        'open:group-technical',
        preference.values['open:group-technical'] !== true,
      ),
  };
}
