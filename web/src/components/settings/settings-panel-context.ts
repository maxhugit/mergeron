import { createContext } from 'react';

/** Portals retain the owning form's state and handlers; the panel owns scrolling. */
export const SettingsPanelContext = createContext<{
  footer: HTMLDivElement | null;
} | null>(null);
