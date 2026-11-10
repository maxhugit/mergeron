import { createContext, useContext } from 'react';
export interface ActivitySnapshot {
  agents: {
    running: number;
    waiting: number;
    total: number;
    stale: boolean;
    refreshedAt: number | null;
    items: { threadId: string; name: string; state: 'running' | 'waiting' }[];
  };
  operations: {
    total: number;
    items: { id: string; kind: 'media' | 'preview'; threadId: string | null }[];
  };
  installation: {
    version: string | null;
    channel: 'edge' | 'stable' | 'unknown';
    environment: 'development' | 'production' | 'unknown';
  };
}
export interface ActivityState {
  data?: ActivitySnapshot;
  unavailable: boolean;
  connection: 'connected' | 'reconnecting' | 'offline';
  show: (trigger: HTMLElement) => void;
  restoreFocus: () => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  tabletBar: boolean;
  setTabletBar: (show: boolean) => void;
  preferenceError: boolean;
  refresh: () => void;
}
export const ActivityContext = createContext<ActivityState | null>(null);
export const useActivity = () => useContext(ActivityContext);
