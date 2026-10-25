import { afterEach, expect, it, vi } from 'vitest';
import {
  readManagerUpdateReceipt,
  saveManagerUpdateReceipt,
  retainManagerUpdateSnapshot,
} from './manager-update-recovery';

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

it('keeps a bounded display-only journal, omitting image references, errors and unknown fields', () => {
  const startedAt = Date.now();
  saveManagerUpdateReceipt({
    startedAt,
    operationId: 'operation',
    excludedOperationId: 'previous',
  });
  retainManagerUpdateSnapshot(startedAt, {
    id: 'operation',
    status: 'running',
    phase: 'backingUp',
    backupRetained: false,
    images: { application: 'SECRET' },
    previousImages: {},
    error: 'SECRET',
    events: [
      { at: new Date().toISOString(), phase: 'backingUp', status: 'running' },
    ],
  });
  expect(readManagerUpdateReceipt()?.snapshot).toMatchObject({
    id: 'operation',
    phase: 'backingUp',
    images: {},
    previousImages: {},
  });
  expect(JSON.stringify(readManagerUpdateReceipt())).not.toContain('SECRET');
  retainManagerUpdateSnapshot(startedAt, {
    id: 'unrelated',
    status: 'running',
    phase: 'preparing',
    backupRetained: false,
    images: {},
    previousImages: {},
    events: [],
  });
  expect(readManagerUpdateReceipt()?.snapshot?.id).toBe('operation');
});

it('retains only a tab-local operation receipt and expires it after one hour', () => {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const receipt = {
    startedAt: now,
    operationId: 'operation',
    excludedOperationId: 'previous',
  };
  saveManagerUpdateReceipt(receipt);
  expect(readManagerUpdateReceipt()).toEqual(receipt);
  vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60_000 + 1);
  expect(readManagerUpdateReceipt()).toBeNull();
});

it('never blocks the update if browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Unavailable');
  });
  expect(() =>
    saveManagerUpdateReceipt({
      startedAt: Date.now(),
      operationId: null,
      excludedOperationId: null,
    }),
  ).not.toThrow();
  expect(readManagerUpdateReceipt()).toBeNull();
});

it('ignores malformed receipts rather than restoring an unrelated operation', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(
    JSON.stringify({
      startedAt: Date.now(),
      operationId: {},
      excludedOperationId: null,
    }),
  );
  expect(readManagerUpdateReceipt()).toBeNull();
});
