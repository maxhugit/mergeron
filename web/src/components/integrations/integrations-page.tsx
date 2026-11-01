/** Legacy entry point retained for existing links. */
import { useRouterState } from '@tanstack/react-router';
import {
  IntegrationsPanel,
  type IntegrationSection,
} from './integrations-panel';
export function IntegrationsPage() {
  const tab = useRouterState({
    select: (state) =>
      (state.location.search as { tab?: IntegrationSection }).tab,
  });
  return (
    <div className="flex-1 overflow-auto p-4">
      <IntegrationsPanel
        initialSection={tab === 'apps' || tab === 'mcps' ? tab : 'plugins'}
      />
    </div>
  );
}
