import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagerBackups } from './manager-backups';
import type { ManagerStatus } from './manager-status-api';
const api = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  retention: vi.fn(),
  save: vi.fn(),
}));
vi.mock('./manager-status-api', async (original) => ({
  ...(await original<typeof import('./manager-status-api')>()),
  requestManagerBackups: api.list,
  deleteManagerBackup: api.remove,
  requestManagerRetention: api.retention,
  saveManagerRetention: api.save,
}));
const status = {
  available: true,
  capabilities: { backupManagement: true },
  update: { busy: false, operation: null },
} as ManagerStatus;
const backup = {
  id: 'backup',
  path: '/srv/mergeron/manager-state/updates/backup/backup',
  sizeBytes: 2048,
  createdAt: '2026-10-25T17:19:18Z',
  current: true,
  status: 'succeeded',
  restorable: true,
  canDelete: true,
  protectionReason: null,
};
beforeEach(() => {
  api.retention.mockResolvedValue({ maxBackups: 10 });
  api.save.mockImplementation(async (maxBackups: number) => ({ maxBackups }));
  api.list.mockResolvedValue({ backups: [backup], totalSizeBytes: 2048 });
  api.remove.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function setup(value = status) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <ManagerBackups status={value} />
    </QueryClientProvider>,
  );
}

it('keeps old backups manageable but does not offer a retention setting when Dev creates no new backups', async () => {
  setup({
    ...status,
    backupPolicy: 'development-none-v1',
    capabilities: { backupManagement: true, backupRetention: true },
  });
  expect(await screen.findByText(/Dev: no data backup/)).toBeVisible();
  expect(
    await screen.findByRole('button', { name: 'Delete backup' }),
  ).toBeVisible();
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  expect(api.retention).not.toHaveBeenCalled();
});

it.each([
  ['production-essential-v1', 'Essential data'],
  ['legacy-full-v1', 'Historical full backup'],
])(
  'shows the recorded %s scope for an individual backup',
  async (backupPolicy, label) => {
    api.list.mockResolvedValue({
      backups: [{ ...backup, backupPolicy }],
      totalSizeBytes: 2048,
    });
    setup();
    expect(await screen.findByText(label)).toBeVisible();
  },
);

it('loads ten by default and saves a validated limit without deleting any backup', async () => {
  setup({
    ...status,
    capabilities: { backupManagement: true, backupRetention: true },
  });
  const input = await screen.findByRole('spinbutton', {
    name: 'Number of backups to keep',
  });
  expect(input).toHaveValue(10);
  fireEvent.change(input, { target: { value: '0' } });
  expect(screen.getByRole('button', { name: 'Save limit' })).toBeDisabled();
  fireEvent.change(input, { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
  await screen.findByText('Limit saved.');
  expect(api.save).toHaveBeenCalledWith(2, expect.anything());
  expect(api.remove).not.toHaveBeenCalled();
});

it('shows the verified server path, disk usage and total usage', async () => {
  setup();
  expect(await screen.findByText(/Server path: \/srv\/mergeron/)).toBeVisible();
  expect(screen.getByText('Disk usage: 2 KiB')).toBeVisible();
  expect(screen.getByText('Total backup disk usage: 2 KiB')).toBeVisible();
});
it('keeps date and identifier in separate columns', async () => {
  setup();
  const table = await screen.findByRole('table');
  await screen.findByText('backup');
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent),
  ).toEqual(['Date', 'Identifier', 'Server path', 'Size', 'Status', 'Actions']);
  const row = within(table).getAllByRole('row')[1];
  const cells = within(row).getAllByRole('cell');
  expect(cells).toHaveLength(6);
  expect(cells[0].querySelector('time')).not.toBeNull();
  expect(cells[1]).toHaveTextContent('backup');
});

it('distinguishes a background calculation from unavailable disk usage', async () => {
  api.list.mockResolvedValue({
    backups: [{ ...backup, sizeBytes: null, sizeStatus: 'calculating' }],
    totalSizeBytes: null,
    sizesCalculating: true,
  });
  setup();
  expect(await screen.findByText('Disk usage: Calculating…')).toBeVisible();
  expect(
    screen.getByText('Total backup disk usage: Calculating…'),
  ).toBeVisible();
  expect(screen.queryByText(/Unavailable/)).not.toBeInTheDocument();
});
it('lists backup dates and requires confirmation before deletion', async () => {
  setup();
  expect(await screen.findByText('backup')).toBeInTheDocument();
  expect(document.querySelector('time')).toHaveAttribute(
    'dateTime',
    backup.createdAt,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete backup' }));
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete backup' }));
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Delete backup' }).at(-1)!,
  );
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith('backup'));
});
it('disables deletion during an operation', async () => {
  setup({ ...status, update: { busy: true, operation: null } });
  expect(
    await screen.findByRole('button', { name: 'Delete backup' }),
  ).toBeDisabled();
});
it('keeps unknown backups protected', async () => {
  api.list.mockResolvedValueOnce({
    backups: [
      {
        ...backup,
        canDelete: false,
        protectionReason: 'managerBackupMetadataProtected',
      },
    ],
  });
  setup();
  expect(
    await screen.findByRole('button', { name: 'Delete backup' }),
  ).toBeDisabled();
  expect(
    screen.getByText(/metadata could not be verified/),
  ).toBeInTheDocument();
});
it('shows an actionable message for managers without backup support', () => {
  setup({ ...status, capabilities: undefined });
  expect(screen.getByText(/Update Mergeron Manager/)).toBeInTheDocument();
  expect(api.list).not.toHaveBeenCalled();
});
it('keeps confirmation open on failure and never repeats deletion automatically', async () => {
  api.remove.mockRejectedValueOnce(new Error('Busy'));
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete backup' }));
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Delete backup' }).at(-1)!,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not delete',
  );
  expect(api.remove).toHaveBeenCalledTimes(1);
});
