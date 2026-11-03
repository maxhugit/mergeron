import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskDeliverableLink } from './task-deliverable-link';
import type { ProjectTaskSummary } from '@/lib/projects-api';
import type { Deliverable } from '@/lib/deliverables-api';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/projects-api', () => ({ projectsApi: api }));
beforeEach(() => {
  api.mockReset().mockResolvedValue({});
});
function setup() {
  const close = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskDeliverableLink
        projectId="p"
        resourceId="r"
        task={
          { id: 'task', title: 'Rédiger', updatedAt: 42 } as ProjectTaskSummary
        }
        deliverables={
          [
            {
              id: 'free',
              title: 'Available',
              version: 3,
              lifecycleStatus: 'in_constitution',
              primaryTaskId: null,
            },
            {
              id: 'locked',
              title: 'Final',
              lifecycleStatus: 'finalized',
              primaryTaskId: null,
            },
            {
              id: 'busy',
              title: 'Already linked',
              lifecycleStatus: 'draft',
              primaryTaskId: 'other',
            },
          ] as Deliverable[]
        }
        onClose={close}
      />
    </QueryClientProvider>,
  );
  return close;
}
it('links an editable existing deliverable with observed task and document revisions', async () => {
  const close = setup();
  expect(screen.queryByRole('option', { name: 'Final' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'Already linked' })).toBeNull();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'free' } });
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(api).toHaveBeenCalledWith(
    '/p/resources/r/deliverables/link-task',
    expect.objectContaining({
      body: JSON.stringify({
        taskId: 'task',
        expectedTaskUpdatedAt: 42,
        deliverableId: 'free',
        expectedVersion: 3,
      }),
    }),
  );
});
it('creates and links in one server action without a detached intermediate record', async () => {
  const close = setup();
  fireEvent.click(
    screen.getByRole('button', { name: 'Create a new deliverable' }),
  );
  expect(screen.getByRole('textbox')).toHaveValue('Rédiger');
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'New report' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create and link' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(api).toHaveBeenCalledWith(
    '/p/resources/r/deliverables/link-task',
    expect.objectContaining({
      body: JSON.stringify({
        taskId: 'task',
        expectedTaskUpdatedAt: 42,
        title: 'New report',
      }),
    }),
  );
});
it('preserves the dialog on a conflicting association so the user can refresh', async () => {
  api.mockRejectedValue(new Error('Conflict'));
  const close = setup();
  api.mockRejectedValue(new Error('Conflict'));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'free' } });
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  await screen.findByRole('alert');
  expect(close).not.toHaveBeenCalled();
});
