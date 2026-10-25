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
  expect(within(dialog).getByText(/app.22.log/)).toHaveTextContent(
    'active — protected',
  );
  expect(
    within(dialog).getByText(/This diagnostic log is not conversation history/),
  ).toBeInTheDocument();
});
it('saves one policy per family without using the dynamic filenames as keys', async () => {
  const close = vi.fn();
  wrap(<LogRetentionDialog storage={storage} onClose={close} />);
  const groups = screen.getAllByRole('group');
  fireEvent.change(
    within(groups[0]).getByLabelText(
      'Maximum archives (excluding active file)',
    ),
    { target: { value: '3' } },
  );
  fireEvent.click(within(groups[1]).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(api.saveLogRetention).toHaveBeenCalledWith({
      application: { ...storage.policy.application, maxFiles: 3 },
      codex: { ...storage.policy.codex, enabled: true },
    }),
  );
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
it('keeps the dialog open after a failed save', async () => {
  const close = vi.fn();
  api.saveLogRetention.mockRejectedValueOnce(new Error('Unavailable'));
  wrap(<LogRetentionDialog storage={storage} onClose={close} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
  expect(close).not.toHaveBeenCalled();
});
