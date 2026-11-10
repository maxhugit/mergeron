import { useState, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { useConnectionStore } from '@/stores/connection-store';
import { useSessionPaused } from '@/lib/session-recovery';
import { ActivityContext, type ActivitySnapshot } from './activity-state';
const subscribeOnline = (notify: () => void) => {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
};
const onlineSnapshot = () => navigator.onLine;
function readTabletPreference(key: string) {
  try {
    return localStorage.getItem(key) !== 'hidden';
  } catch {
    return true;
  }
}
function ActivityScope({
  owner,
  children,
}: {
  owner: string;
  children: ReactNode;
}) {
  const connected = useConnectionStore((state) => state.connected);
  const paused = useSessionPaused();
  const online = useSyncExternalStore(
    subscribeOnline,
    onlineSnapshot,
    () => true,
  );
  const opener = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const preferenceKey = 'mergeron:activity-bar:' + owner;
  const [preference, setPreference] = useState(() => ({
    key: preferenceKey,
    show: readTabletPreference(preferenceKey),
  }));
  const [preferenceError, setPreferenceError] = useState(false);
  const tabletBar =
    preference.key === preferenceKey
      ? preference.show
      : readTabletPreference(preferenceKey);
  const query = useQuery({
    queryKey: ['platform-activity', owner],
    queryFn: async ({ signal }): Promise<ActivitySnapshot> => {
      const auth = getAuthorizationHeader();
      const response = await fetch(withBasePath('/api/activity'), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: auth ? { Authorization: auth } : {},
      });
      if (!response.ok) throw new Error('Activity unavailable');
      const value = (await response.json()) as ActivitySnapshot;
      if (
        !value?.agents ||
        !Array.isArray(value.agents.items) ||
        !value.operations ||
        !Array.isArray(value.operations.items) ||
        !value.installation
      )
        throw new Error('Invalid activity');
      return value;
    },
    enabled: !paused && online,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
    retry: false,
  });
  return (
    <ActivityContext.Provider
      value={{
        data: paused || !online || query.isError ? undefined : query.data,
        unavailable: paused || !online || query.isError,
        connection: !online
          ? 'offline'
          : connected && !paused
            ? 'connected'
            : 'reconnecting',
        show: (trigger) => {
          opener.current = trigger;
          setOpen(true);
        },
        restoreFocus: () => {
          if (opener.current?.isConnected) opener.current.focus();
        },
        open,
        setOpen,
        tabletBar,
        preferenceError,
        setTabletBar: (show) => {
          setPreference({ key: preferenceKey, show });
          try {
            localStorage.setItem(preferenceKey, show ? 'visible' : 'hidden');
            setPreferenceError(false);
          } catch {
            setPreferenceError(true);
          }
        },
        refresh: () => {
          void query.refetch();
        },
      }}
    >
      {children}
    </ActivityContext.Provider>
  );
}

export function ActivityProvider({
  owner,
  children,
}: {
  owner: string;
  children: ReactNode;
}) {
  return (
    <ActivityScope key={owner} owner={owner}>
      {children}
    </ActivityScope>
  );
}
