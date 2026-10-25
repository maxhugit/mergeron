import { withBasePath } from '@/base-path';

/** A tab-local UI receipt, never an authentication or mutation-replay token. */
export interface ManagerUpdateReceipt {
  startedAt: number;
  operationId: string | null;
  excludedOperationId: string | null;
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
    return receipt;
  } catch {
    return null;
  }
}

export function saveManagerUpdateReceipt(receipt: ManagerUpdateReceipt | null) {
  try {
    if (receipt) sessionStorage.setItem(key, JSON.stringify(receipt));
    else sessionStorage.removeItem(key);
  } catch {
    // Storage may be unavailable. Never block an administrator's explicit action.
  }
}
