import { expect, it, vi } from 'vitest';
import { createProjectAgent } from './project-agent-creation';
const api = vi.hoisted(() => vi.fn());
vi.mock('./projects-api', () => ({ projectsApi: api }));
it('captures each project in its own request, without a native start followed by a second association', async () => {
  api.mockResolvedValue({ thread: { id: 'new' } });
  await Promise.all([
    createProjectAgent({ projectId: 'p1', workspacePath: '/p1' }),
    createProjectAgent({ projectId: 'p2', workspacePath: '/p2' }),
  ]);
  expect(api.mock.calls).toEqual([
    [
      '/p1/agents',
      { method: 'POST', body: JSON.stringify({ workspacePath: '/p1' }) },
    ],
    [
      '/p2/agents',
      { method: 'POST', body: JSON.stringify({ workspacePath: '/p2' }) },
    ],
  ]);
});
