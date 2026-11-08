import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
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
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <SubtaskProgressEditor projectId="p" task={value}>
      {(progress) => <output>{progress} %</output>}
    </SubtaskProgressEditor>,
    { wrapper },
  );
}
beforeEach(() => {
  state.admin = true;
  state.api
    .mockReset()
    .mockResolvedValue({ task: { progress: 65, updatedAt: 9 } });
});
it('shows one slider, no number field or save button, and commits only once on release', async () => {
  fixture();
  const slider = screen.getByRole('slider');
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  for (const value of [45, 50, 65])
    fireEvent.change(slider, { target: { value: String(value) } });
  expect(state.api).not.toHaveBeenCalled();
  expect(screen.getByText('65 %')).toBeVisible();
  fireEvent.pointerUp(slider);
  fireEvent.blur(slider);
  await waitFor(() => expect(state.api).toHaveBeenCalledTimes(1));
  expect(state.api).toHaveBeenCalledWith('/p/resources/tasks/tasks/sub', {
    method: 'PATCH',
    body: JSON.stringify({ progress: 65, expectedUpdatedAt: 7 }),
  });
  await waitFor(() => expect(slider).not.toBeDisabled());
  expect(screen.getByText('65 %')).toBeVisible();
});
it('uses the revision observed at the start of editing if a refresh arrives before release', async () => {
  const view = fixture();
  fireEvent.change(screen.getByRole('slider'), { target: { value: '65' } });
  view.rerender(
    <SubtaskProgressEditor projectId="p" task={{ ...task, updatedAt: 8 }} />,
  );
  fireEvent.pointerUp(screen.getByRole('slider'));
  await waitFor(() => expect(state.api).toHaveBeenCalled());
  expect(JSON.parse(state.api.mock.calls[0][1].body).expectedUpdatedAt).toBe(7);
});
it('saves keyboard changes without marking a subtask completed and uses the server confirmed value', async () => {
  state.api.mockResolvedValue({ task: { progress: 100, updatedAt: 10 } });
  fixture();
  const slider = screen.getByRole('slider');
  fireEvent.change(slider, { target: { value: '100' } });
  fireEvent.keyUp(slider, { key: 'End' });
  await waitFor(() => expect(state.api).toHaveBeenCalled());
  expect(JSON.parse(state.api.mock.calls[0][1].body)).toEqual({
    progress: 100,
    expectedUpdatedAt: 7,
  });
  await waitFor(() => expect(screen.getByText('100 %')).toBeVisible());
});
it('retains unsaved input after failure and supports retry without silently changing its revision', async () => {
  state.api.mockRejectedValueOnce(Error('Conflict'));
  fixture();
  const slider = screen.getByRole('slider');
  fireEvent.change(slider, { target: { value: '60' } });
  fireEvent.pointerUp(slider);
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(slider).toHaveValue('60');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(state.api).toHaveBeenCalledTimes(2));
  expect(JSON.parse(state.api.mock.calls[1][1].body)).toEqual({
    progress: 60,
    expectedUpdatedAt: 7,
  });
});
it('keeps completed tasks locked and renders a single read-only track for readers', () => {
  const view = fixture({ ...task, progress: 100, subtaskStatus: 'done' });
  expect(screen.getByRole('slider')).toBeDisabled();
  view.unmount();
  state.admin = false;
  fixture();
  expect(screen.queryByRole('slider')).toBeNull();
  expect(screen.getAllByRole('progressbar')).toHaveLength(1);
});
it('discards a cancelled pointer gesture without submitting', async () => {
  fixture();
  const slider = screen.getByRole('slider');
  fireEvent.change(slider, { target: { value: '80' } });
  fireEvent.pointerCancel(slider);
  fireEvent.blur(slider);
  await act(async () => Promise.resolve());
  expect(state.api).not.toHaveBeenCalled();
  expect(screen.getByText('40 %')).toBeVisible();
});
