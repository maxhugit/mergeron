import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useCurrentProject } from './use-current-project';
const mock = vi.hoisted(() => ({ cwd: '/workspace/other', binding: true }));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: '/t/agent' } }),
}));
vi.mock('@/stores/timeline-store', () => ({
  useTimelineStore: (select: (state: unknown) => unknown) =>
    select({ threadId: 'agent', threadCwd: mock.cwd }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      projects: [
        {
          id: 'bound',
          workspacePath: '/workspace/bound',
          workspaces: [{ path: '/workspace/bound' }],
          agentThreads: mock.binding ? [{ threadId: 'agent' }] : [],
        },
        {
          id: 'cwd',
          workspacePath: '/workspace/other',
          workspaces: [{ path: '/workspace/other' }],
        },
      ],
    },
  }),
}));
beforeEach(() => {
  mock.cwd = '/workspace/other';
  mock.binding = true;
});
it('prefers explicit agent membership over a misleading external-copy cwd', () => {
  expect(renderHook(useCurrentProject).result.current?.id).toBe('bound');
});
it('keeps workspace fallback for unbound conversations and does not invent a project', () => {
  mock.binding = false;
  const view = renderHook(useCurrentProject);
  expect(view.result.current?.id).toBe('cwd');
  mock.cwd = '/unrelated';
  view.rerender();
  expect(view.result.current).toBeUndefined();
});
