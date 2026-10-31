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
import { LogRetentionDialog } from './log-retention-dialog';
import { LogsMonitor } from './logs-monitor';
import type { LogStorage } from '@/lib/logs-api';

const api = vi.hoisted(() => ({
  readLogs: vi.fn(),
  readLogStorage: vi.fn(),
  saveLogRetention: vi.fn(),
  saveLogRetentionRule: vi.fn(),
}));
vi.mock('@/lib/logs-api', () => api);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: globalThis.__testTranslate,
    i18n: { language: 'en' },
  }),
}));
const storage: LogStorage = {
  estimatedBytes: 1048576,
  files: [
    {
      name: 'app.22.log',
      bytes: 128,
      modifiedAt: 1,
      family: 'application',
      active: true,
    },
    {
      name: 'codex-jsonrpc.jsonl',
      bytes: 1048448,
      modifiedAt: 1,
      family: 'codex',
      active: true,
    },
  ],
  policy: {
    application: { enabled: true, maxAgeDays: 30, maxFiles: 5 },
    codex: { enabled: false, maxAgeDays: 30, maxFiles: 5, maxFileMiB: 50 },
  },
};
function wrap(element: React.ReactNode) {
  return render(
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
      {element}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  api.readLogs.mockResolvedValue({
    data: [],
    total: 0,
    offset: 0,
    limit: 100,
    hasMore: false,
    availableLevels: ['info'],
    availableSources: [],
  });
  api.readLogStorage.mockResolvedValue(storage);
  api.saveLogRetention.mockResolvedValue({ policy: storage.policy });
  api.saveLogRetentionRule.mockResolvedValue({ policy: storage.policy });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('shows total server storage independently of level filters and opens retention settings', async () => {
  wrap(<LogsMonitor />);
  expect(await screen.findByText('Logs: ≈ 1.0 MiB')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'info' }));
  expect(screen.getByText('Logs: ≈ 1.0 MiB')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Log retention' }));
  const dialog = screen.getByRole('dialog', { name: 'Log retention' });
  expect(within(dialog).getByRole('table')).toBeInTheDocument();
  expect(
    within(dialog).getByRole('row', { name: /Application/ }),
  ).toHaveTextContent('0 / 5');
  expect(
    within(dialog).getByRole('row', { name: /Codex JSON-RPC/ }),
  ).toHaveTextContent('Disabled');
  expect(api.saveLogRetentionRule).not.toHaveBeenCalled();
  await openFamily('Codex JSON-RPC');
  expect(
    screen.getByText(/This diagnostic log is not conversation history/),
  ).toBeInTheDocument();
});
async function openFamily(name: string, action = 'Configure retention') {
  fireEvent.pointerDown(
    screen.getByRole('button', { name: `Actions · ${name}` }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole('menuitem', { name: action }));
  return screen.findByRole('dialog', { name: `Logs · ${name}` });
}
it('saves only the selected family and leaves the summary open', async () => {
  const close = vi.fn();
  wrap(<LogRetentionDialog storage={storage} onClose={close} />);
  const dialog = await openFamily('Application');
  fireEvent.change(
    within(dialog).getByLabelText('Maximum archives (excluding active file)'),
    { target: { value: '3' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(api.saveLogRetentionRule).toHaveBeenCalledWith('application', {
      ...storage.policy.application,
      maxFiles: 3,
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Logs · Application' }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole('dialog', { name: 'Log retention' }),
  ).toBeInTheDocument();
  expect(api.saveLogRetention).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});
it('refreshes the real monitor summary after saving one family without changing the other', async () => {
  let current = structuredClone(storage);
  api.readLogStorage.mockImplementation(() => Promise.resolve(current));
  api.saveLogRetentionRule.mockImplementationOnce(async (_family, rule) => {
    current = { ...current, policy: { ...current.policy, application: rule } };
    return { policy: current.policy };
  });
  wrap(<LogsMonitor />);
  fireEvent.click(await screen.findByRole('button', { name: 'Log retention' }));
  const dialog = await openFamily('Application');
  fireEvent.change(
    within(dialog).getByLabelText('Maximum archives (excluding active file)'),
    { target: { value: '3' } },
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.getByRole('row', { name: /Application/ })).toHaveTextContent(
      '0 / 3',
    ),
  );
  expect(screen.getByRole('row', { name: /Codex JSON-RPC/ })).toHaveTextContent(
    'Disabled',
  );
  expect(current.policy.codex).toEqual(storage.policy.codex);
});
it('keeps the dialog open after a failed save', async () => {
  const close = vi.fn();
  api.saveLogRetentionRule.mockRejectedValueOnce(new Error('Unavailable'));
  wrap(<LogRetentionDialog storage={storage} onClose={close} />);
  await openFamily('Codex JSON-RPC');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
  expect(close).not.toHaveBeenCalled();
});
it('prevents closing or resubmitting a rule while its save is pending', async () => {
  let finish!: (value: { policy: LogStorage['policy'] }) => void;
  api.saveLogRetentionRule.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const close = vi.fn();
  wrap(<LogRetentionDialog storage={storage} onClose={close} />);
  const dialog = await openFamily('Codex JSON-RPC');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.saveLogRetentionRule).toHaveBeenCalledOnce());
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(within(dialog).getByRole('checkbox')).toBeDisabled();
  fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
  expect(dialog).toBeInTheDocument();
  finish({ policy: storage.policy });
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Logs · Codex JSON-RPC' }),
    ).not.toBeInTheDocument(),
  );
  expect(close).not.toHaveBeenCalled();
});
it('counts archives separately from active files and sums every byte of the family', () => {
  const extra: LogStorage['files'] = [
    {
      name: 'app.21.log',
      bytes: 384,
      modifiedAt: 1,
      family: 'application',
      active: false,
    },
    {
      name: 'unmanaged.log',
      bytes: 2048,
      modifiedAt: 1,
      family: 'other',
      active: false,
    },
  ];
  wrap(
    <LogRetentionDialog
      storage={{ ...storage, files: [...storage.files, ...extra] }}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole('row', { name: /Application/ })).toHaveTextContent(
    '1 / 5',
  );
  expect(screen.getByRole('row', { name: /Application/ })).toHaveTextContent(
    '512 B',
  );
  const other = screen.getByRole('row', { name: /Other files/ });
  expect(other).toHaveTextContent('Unmanaged');
  expect(other).toHaveTextContent('2.0 KiB');
});
it('allows inspecting unknown files but offers no save or retention controls', async () => {
  wrap(
    <LogRetentionDialog
      storage={{
        ...storage,
        files: [
          {
            name: 'unknown.log',
            bytes: 123,
            modifiedAt: 1,
            family: 'other',
            active: false,
          },
        ],
      }}
      onClose={vi.fn()}
    />,
  );
  const dialog = await openFamily('Other files', 'View files');
  expect(within(dialog).getByText('unknown.log')).toBeInTheDocument();
  expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
  expect(
    within(dialog).queryByRole('button', { name: 'Save' }),
  ).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByText('Close', { selector: 'button' }));
  expect(api.saveLogRetentionRule).not.toHaveBeenCalled();
});
it('explains oversized archives without offering to delete or truncate them', async () => {
  const archive: LogStorage['files'][number] = {
    name: 'codex-jsonrpc.123-11111111-1111-1111-1111-111111111111.jsonl',
    bytes: 8 * 1024 ** 3,
    modifiedAt: 1,
    family: 'codex',
    active: false,
  };
  wrap(
    <LogRetentionDialog
      storage={{ ...storage, files: [...storage.files, archive] }}
      onClose={vi.fn()}
    />,
  );
  expect(
    screen.getByText('Archive exceeds the rotation threshold'),
  ).toBeInTheDocument();
  const dialog = await openFamily('Codex JSON-RPC');
  expect(within(dialog).getByRole('note')).toHaveTextContent(
    'not a total storage limit',
  );
  expect(within(dialog).getByText(archive.name)).toBeInTheDocument();
  expect(
    within(dialog).queryByRole('button', { name: /delete/i }),
  ).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(api.saveLogRetentionRule).not.toHaveBeenCalled();
});
it('shows configured empty families and keeps cancelled edits out of the next editor', async () => {
  wrap(
    <LogRetentionDialog
      storage={{ ...storage, files: [], estimatedBytes: 0 }}
      onClose={vi.fn()}
    />,
  );
  const first = await openFamily('Application');
  expect(
    within(first).getByText('No files for this log type.'),
  ).toBeInTheDocument();
  fireEvent.change(
    within(first).getByLabelText('Maximum archives (excluding active file)'),
    { target: { value: '2' } },
  );
  fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
  const second = await openFamily('Application');
  expect(
    within(second).getByLabelText('Maximum archives (excluding active file)'),
  ).toHaveValue(5);
  expect(api.saveLogRetentionRule).not.toHaveBeenCalled();
});
