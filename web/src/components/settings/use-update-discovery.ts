import { useEffect, useState } from 'react';
import { discoverRunningUpdate } from './update-monitor-api';
import type { ManagerUpdateReceipt } from './manager-update-recovery';

/** Shared HttpOnly monitoring cookies work across tabs; receipts are tab-local. */
export function useUpdateDiscovery(enabled: boolean) {
  const [discovered, setDiscovered] = useState<ManagerUpdateReceipt | null>(
    null,
  );
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const check = async () => {
      request = new AbortController();
      const deadline = setTimeout(() => request?.abort(), 4000);
      try {
        const id = await discoverRunningUpdate(request.signal);
        if (active && id)
          setDiscovered((current) =>
            current?.operationId === id
              ? current
              : {
                  startedAt: Date.now(),
                  operationId: id,
                  excludedOperationId: null,
                  independentMonitor: true,
                },
          );
      } catch {
        /* Unavailable or unauthorized: keep ordinary session recovery. */
      } finally {
        clearTimeout(deadline);
        if (active) timer = setTimeout(() => void check(), 5000);
      }
    };
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
      request?.abort();
    };
  }, [enabled]);
  return discovered;
}
