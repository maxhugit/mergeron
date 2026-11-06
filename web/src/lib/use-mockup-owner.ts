import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { platformSessionKey, type PlatformSession } from './platform-session';
/** Observe existing verification only; never register another auth query or refresh policy. */
export function useMockupOwner() {
  const client = useQueryClient();
  const subscribe = useCallback(
    (notify: () => void) => client.getQueryCache().subscribe(notify),
    [client],
  );
  const snapshot = useCallback(
    () => client.getQueryData<PlatformSession>(platformSessionKey),
    [client],
  );
  const session = useSyncExternalStore(subscribe, snapshot, snapshot);
  return session?.active && session.kind === 'person' && !session.impersonation
    ? session.personId
    : null;
}
