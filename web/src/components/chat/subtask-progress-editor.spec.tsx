import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { SubtaskProgressEditor } from './subtask-progress-editor';
import type { ProjectTaskSummary } from '@/lib/projects-api';
const state = vi.hoisted(() => ({ admin: true, api: vi.fn() }));
vi.mock('@/lib/projects-api', () => ({ projectsApi: state.api }));
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: state.admin }),
}));
const task = {
  id: 'sub',
  title: 'Draft',
  resourceId: 'tasks',
  progress: 40,
  updatedAt: 7,
  subtaskStatus: 'started',
} as ProjectTaskSummary;
function fixture(value = task) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <SubtaskProgressEditor projectId="p" task={value} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  state.admin = true;
  state.api.mockReset().mockResolvedValue({});
});
it('saves only progress with the observed revision, even if the task refreshes while editing', async () => {
  const view = fixture();
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '65' } });
  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <SubtaskProgressEditor projectId="p" task={{ ...task, updatedAt: 8 }} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(state.api).toHaveBeenCalledWith('/p/resources/tasks/tasks/sub', {
      method: 'PATCH',
      body: JSON.stringify({ progress: 65, expectedUpdatedAt: 7 }),
    }),
  );
});
it('does not mark a subtask completed at 100 percent', async () => {
  fixture();
  fireEvent.change(screen.getByRole('slider'), { target: { value: '100' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(state.api).toHaveBeenCalled());
  expect(JSON.parse(state.api.mock.calls[0][1].body)).toEqual({
    progress: 100,
    expectedUpdatedAt: 7,
  });
});
it('shows save failures and retains the draft without claiming a saved result', async () => {
  state.api.mockRejectedValue(Error('Conflict'));
  fixture();
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '60' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.getByRole('spinbutton')).toHaveValue(60);
});
it('keeps completed tasks locked and hides editing from readers', () => {
  const view = fixture({ ...task, progress: 100, subtaskStatus: 'done' });
  expect(screen.getByRole('slider')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  view.unmount();
  state.admin = false;
  fixture();
  expect(screen.queryByRole('slider')).toBeNull();
});
