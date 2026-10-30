import { withBasePath } from '@/base-path';
import type { ManagerUpdateOperation } from './manager-status-api';

/** A tab-local UI receipt, never an authentication or mutation-replay token. */
export interface ManagerUpdateReceipt {
  startedAt: number;
  operationId: string | null;
  excludedOperationId: string | null;
  /** Display-only journal. It never authorizes a request or restores a session. */
  snapshot?: ManagerUpdateOperation;
}
const key = withBasePath('/manager-update-recovery');
const maxAge = 60 * 60_000;

export function readManagerUpdateReceipt(): ManagerUpdateReceipt | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const receipt = value as ManagerUpdateReceipt;
    if (
      !Number.isFinite(receipt.startedAt) ||
      receipt.startedAt > Date.now() ||
      Date.now() - receipt.startedAt > maxAge ||
      !(
        receipt.operationId === null || typeof receipt.operationId === 'string'
      ) ||
      !(
        receipt.excludedOperationId === null ||
        typeof receipt.excludedOperationId === 'string'
      )
    )
      return null;
    const snapshot = sanitizeSnapshot(receipt.snapshot);
    return {
      startedAt: receipt.startedAt,
      operationId: receipt.operationId,
      excludedOperationId: receipt.excludedOperationId,
      ...(snapshot &&
      snapshot.id !== receipt.excludedOperationId &&
      (!receipt.operationId || snapshot.id === receipt.operationId)
        ? { snapshot }
        : {}),
    };
  } catch {
    return null;
  }
}

export function saveManagerUpdateReceipt(receipt: ManagerUpdateReceipt | null) {
  try {
    if (receipt) {
      const snapshot = sanitizeSnapshot(receipt.snapshot);
      sessionStorage.setItem(
        key,
        JSON.stringify({
          startedAt: receipt.startedAt,
          operationId: receipt.operationId,
          excludedOperationId: receipt.excludedOperationId,
          ...(snapshot ? { snapshot } : {}),
        }),
      );
    } else sessionStorage.removeItem(key);
  } catch {
    // Storage may be unavailable. Never block an administrator's explicit action.
  }
}

/** Keep only bounded, non-sensitive fields needed to draw the last received phase. */
function sanitizeSnapshot(value: unknown): ManagerUpdateOperation | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as ManagerUpdateOperation;
  const phases = new Set([
    'preparing',
    'stopping',
    'backingUp',
    'replacing',
    'checkingHealth',
    'committing',
    'rollingBack',
    'recoveryRequired',
    'complete',
  ]);
  if (
    typeof snapshot.id !== 'string' ||
    snapshot.id.length > 128 ||
    !['running', 'succeeded', 'rolledBack', 'recoveryRequired'].includes(
      snapshot.status,
    ) ||
    !phases.has(snapshot.phase) ||
    !Array.isArray(snapshot.events)
  )
    return null;
  return {
    id: snapshot.id,
    phase: snapshot.phase,
    status: snapshot.status,
    backupRetained: snapshot.backupRetained === true,
    ...([
      'development-none-v1',
      'production-essential-v1',
      'legacy-full-v1',
    ].includes(snapshot.backupPolicy ?? '')
      ? {
          backupPolicy: snapshot.backupPolicy,
          rollbackAvailable: snapshot.rollbackAvailable === true,
        }
      : {}),
    images: {},
    previousImages: {},
    events: snapshot.events
      .slice(-100)
      .filter(
        (event) =>
          event &&
          typeof event.at === 'string' &&
          event.at.length <= 40 &&
          Number.isFinite(Date.parse(event.at)) &&
          phases.has(event.phase) &&
          ['running', 'succeeded', 'rolledBack', 'recoveryRequired'].includes(
            event.status,
          ),
      )
      .map((event) => ({
        at: event.at,
        phase: event.phase,
        status: event.status,
      })),
  };
}

export function retainManagerUpdateSnapshot(
  session: number,
  operation: ManagerUpdateOperation,
) {
  const receipt = readManagerUpdateReceipt();
  if (
    !receipt ||
    receipt.startedAt !== session ||
    operation.id === receipt.excludedOperationId ||
    (receipt.operationId && receipt.operationId !== operation.id)
  )
    return;
  saveManagerUpdateReceipt({
    ...receipt,
    operationId: operation.id,
    snapshot: operation,
  });
}
