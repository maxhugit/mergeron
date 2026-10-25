import { ManagerUpdateProgressDialog } from './manager-update-progress-dialog';
import type { ManagerUpdateReceipt } from './manager-update-recovery';

/** Display-only recovery shell: never mounts private routes or queries the Manager. */
export function ManagerUpdateReconnecting({
  receipt,
}: {
  receipt: ManagerUpdateReceipt;
}) {
  return (
    <main className="min-h-dvh bg-background">
      <ManagerUpdateProgressDialog
        open
        onOpenChange={() => {}}
        operation={receipt.snapshot ?? null}
        pending={false}
        requestError={null}
        session={receipt.startedAt}
        excludedOperationId={receipt.excludedOperationId}
        expectedOperationId={receipt.operationId}
        monitoringPaused
      />
    </main>
  );
}
