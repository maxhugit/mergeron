import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceClose } from './workspace-close-dialog';
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-api', () => ({ browserApi: api }));
const tab: WorkspaceTab = { id: 'browser-1', kind: 'browser', number: 1 };
function Fixture() {
  const { requestClose } = useWorkspaceClose('thread:a');
  return <button onClick={() => requestClose(tab)}>Close</button>;
}
beforeEach(() => {
  api.mockReset();
  useWorkspaceStore.setState({
    contexts: { 'thread:a': { tabs: [tab], activeId: tab.id } },
  });
});
it('releases the exact remote session before making the browser slot reusable', async () => {
  let finish!: () => void;
  api.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(api).toHaveBeenCalledWith('/a/dispose', { instanceId: 'browser-1' });
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toHaveLength(
    1,
  );
  await act(async () => finish());
  await waitFor(() =>
    expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toHaveLength(
      0,
    ),
  );
});
