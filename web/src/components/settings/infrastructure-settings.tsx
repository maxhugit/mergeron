import { RuntimePlacementSettings } from './runtime-placement-settings';
import { TranscriptionServiceCard } from '../transcriptions/transcription-service-card';
import { ManagerStatusCard } from './manager-status-card';

/** Infrastructure inventory is separate from application updates and runtime settings. */
export function InfrastructureSettings() {
  return (
    <div className="space-y-3">
      <RuntimePlacementSettings kind="connections" />
      <ManagerStatusCard />
      <TranscriptionServiceCard />
    </div>
  );
}
