import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectDescription } from './project-description';
import { CreateProjectDialog } from '../chat/sidebar/create-project-dialog';
import type { ProjectSummary } from '@/lib/projects-api';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
vi.mock('@/lib/projects-api', () => ({
  projectsApi: api,
  projectsQueryKey: ['projects'],
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('creates an optional multiline description without submitting on a line break', () => {
  const save = vi.fn();
  render(
    <CreateProjectDialog
      open
      pending={false}
      name="Example"
      onNameChange={() => {}}
      onSave={save}
      onClose={() => {}}
    />,
  );
  const field = screen.getByLabelText('Short description');
  fireEvent.change(field, { target: { value: 'First line\nSecond line' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(save).not.toHaveBeenCalled();
  expect(field).toHaveAttribute('maxlength', '1000');
  fireEvent.click(screen.getByRole('button', { name: 'Create', exact: true }));
  expect(save).toHaveBeenCalledWith('First line\nSecond line');
});
it('loads the description in project settings and saves an edited or empty value', async () => {
  const client = new QueryClient();
  api.mockResolvedValue({});
  render(
    <QueryClientProvider client={client}>
      <ProjectDescription
        project={{ id: 'p', description: 'Saved\nText' } as ProjectSummary}
      />
    </QueryClientProvider>,
  );
  const field = screen.getByLabelText('Short description');
  expect(field).toHaveValue('Saved\nText');
  fireEvent.change(field, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/p', {
      method: 'PATCH',
      body: JSON.stringify({ description: '' }),
    }),
  );
  client.clear();
});
