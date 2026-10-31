import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SecurityPolicyBadge } from './security-policy-badge';
import type { ProjectSummary } from '@/lib/projects-api';
import type { ThreadSecurityPolicyView } from '@/hooks/use-thread-security-policy';

const mock = vi.hoisted(() => ({
  available: true,
  stale: false,
  pending: null as ThreadSecurityPolicyView['pending'],
  outcome: null as ThreadSecurityPolicyView['outcome'],
  isSettling: false,
  apply: vi.fn(),
  savedSandbox: undefined as Record<string, unknown> | null | undefined,
  projects: [] as ProjectSummary[],
  timeline: {
    threadId: 'agent',
    threadCwd: '/project/copy' as string | null,
    threadsById: {} as Record<string, { threadCwd: string | null }>,
  },
  sandbox: {
    type: 'workspaceWrite',
    writableRoots: ['/project'],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: false,
  } as Record<string, unknown>,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores/timeline-store', () => ({
  useTimelineStore: (select: (state: typeof mock.timeline) => unknown) =>
    select(mock.timeline),
}));
vi.mock('@/hooks/use-thread-security-policy', () => ({
  useThreadSecurityPolicy: () => ({
    observed: {
      observed: true,
      approvalPolicy: 'never',
      sandboxPolicy: mock.sandbox,
    },
    apply: mock.apply,
    pending: mock.pending,
    outcome: mock.outcome,
    isSettling: mock.isSettling,
    stale: mock.stale,
  }),
}));
vi.mock('@/hooks/use-thread-execution-preferences', () => ({
  useThreadExecutionPreferences: () => ({
    preferences: {
      revision: 1,
      security: {
        approvalPolicy: 'never',
        sandboxPolicy:
          mock.savedSandbox === undefined ? mock.sandbox : mock.savedSandbox,
      },
    },
    busy: false,
    error: false,
    save: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data:
      queryKey[0] === 'agent-test-profile'
        ? { available: mock.available }
        : { projects: mock.projects },
  }),
}));
beforeEach(() => {
  mock.apply.mockReset();
  mock.savedSandbox = undefined;
  mock.available = true;
  mock.stale = false;
  mock.pending = null;
  mock.outcome = null;
  mock.isSettling = false;
  mock.projects = [];
  mock.timeline = {
    threadId: 'agent',
    threadCwd: '/project/copy',
    threadsById: {},
  };
  mock.sandbox = {
    type: 'workspaceWrite',
    writableRoots: ['/project'],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: false,
  };
});
afterEach(cleanup);
function open(readOnly = false) {
  render(<SecurityPolicyBadge threadId="agent" readOnly={readOnly} />);
  fireEvent.click(
    screen.getByRole('button', { name: /securityPolicyForThisConversation/ }),
  );
}
it('changes networking only after explicit selection, preserving roots and temporary-directory restrictions', () => {
  open();
  expect(mock.apply).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'agentTestProfileEnable' }),
  );
  expect(mock.apply).toHaveBeenCalledExactlyOnceWith({
    sandboxPolicy: { ...mock.sandbox, networkAccess: true },
  });
});
it.each(['unconfirmed', 'read-only', 'unknown', 'stale'])(
  'cannot enable the profile when %s',
  (condition) => {
    if (condition === 'unconfirmed') mock.available = false;
    if (condition === 'stale') mock.stale = true;
    if (condition === 'unknown')
      mock.sandbox = { type: 'readOnly', networkAccess: false };
    open(condition === 'read-only');
    expect(
      screen.getByRole('button', { name: 'agentTestProfileEnable' }),
    ).toBeDisabled();
    expect(mock.apply).not.toHaveBeenCalled();
  },
);
it('can disable command networking without widening or replacing the filesystem policy', () => {
  mock.sandbox.networkAccess = true;
  open();
  fireEvent.click(
    screen.getByRole('button', { name: 'agentTestProfileDisable' }),
  );
  expect(mock.apply).toHaveBeenCalledExactlyOnceWith({
    sandboxPolicy: { ...mock.sandbox, networkAccess: false },
  });
});

function project(
  path: string,
  threadId: string,
  readOnly = false,
): ProjectSummary {
  return {
    id: path,
    name: path,
    workspacePath: path,
    createdAt: 1,
    updatedAt: 1,
    resources: [],
    workspaces: [path, `${path}/copy`, `${path}/other-agent-copy`].map(
      (root, index) => ({
        id: root,
        projectId: path,
        name: root,
        path: root,
        primary: index === 0,
        readOnly,
        createdAt: 1,
        updatedAt: 1,
      }),
    ),
    agentThreads: [
      {
        threadId,
        workspacePath: `${path}/copy`,
        activeFolder: null,
        title: threadId,
        archived: false,
        taskId: null,
        taskResourceId: null,
        taskTitle: null,
        isSubtask: false,
      },
    ],
  };
}

it('only observes security on mount, metadata arrival, agent switches and remounts with other project copies', () => {
  mock.sandbox.writableRoots = [];
  const view = render(<SecurityPolicyBadge threadId="agent" />);
  mock.projects = [project('/project', 'agent')];
  view.rerender(<SecurityPolicyBadge threadId="agent" />);
  mock.projects[0].workspaces.push({
    ...mock.projects[0].workspaces[1],
    id: 'new-copy',
    path: '/project/new-copy',
  });
  view.rerender(<SecurityPolicyBadge threadId="agent" />);
  mock.timeline.threadsById.agent = { threadCwd: '/project/copy' };
  mock.timeline.threadId = 'other';
  mock.timeline.threadCwd = '/project/other-agent-copy';
  view.rerender(<SecurityPolicyBadge threadId="other" />);
  view.rerender(<SecurityPolicyBadge threadId="agent" />);
  view.unmount();
  render(<SecurityPolicyBadge threadId="agent" />);
  expect(mock.apply).not.toHaveBeenCalled();
});

it('keeps each retained badge on its own directory and project when another agent is selected', () => {
  mock.projects = [
    project('/project', 'agent'),
    project('/readonly', 'background', true),
  ];
  mock.timeline.threadsById.background = { threadCwd: '/readonly/copy' };
  const view = render(
    <>
      <div data-testid="active">
        <SecurityPolicyBadge threadId="agent" />
      </div>
      <div data-testid="retained">
        <SecurityPolicyBadge threadId="background" />
      </div>
    </>,
  );
  fireEvent.click(within(screen.getByTestId('retained')).getByRole('button'));
  expect(
    screen.getByRole('button', { name: 'agentTestProfileEnable' }),
  ).toBeDisabled();
  fireEvent.click(within(screen.getByTestId('retained')).getByRole('button'));
  // The former active badge stays editable when the selected thread becomes read-only.
  mock.timeline.threadsById.agent = { threadCwd: '/project/copy' };
  mock.timeline.threadId = 'background';
  mock.timeline.threadCwd = '/readonly/copy';
  view.rerender(
    <>
      <div data-testid="active">
        <SecurityPolicyBadge threadId="agent" />
      </div>
      <div data-testid="retained">
        <SecurityPolicyBadge threadId="background" />
      </div>
    </>,
  );
  fireEvent.click(within(screen.getByTestId('active')).getByRole('button'));
  expect(
    screen.getByRole('button', { name: 'agentTestProfileEnable' }),
  ).toBeEnabled();
  expect(mock.apply).not.toHaveBeenCalled();
});

it('never falls back to the selected agent directory when the retained directory is unknown', () => {
  render(<SecurityPolicyBadge threadId="not-hydrated" />);
  fireEvent.click(
    screen.getByRole('button', { name: /securityPolicyForThisConversation/ }),
  );
  expect(
    screen.getByRole('button', { name: 'agentTestProfileEnable' }),
  ).toBeDisabled();
  expect(
    within(screen.getByRole('dialog')).queryByRole('button', {
      name: /^workspaceWrite/,
    }),
  ).not.toBeInTheDocument();
  expect(mock.apply).not.toHaveBeenCalled();
});

it('does not treat the project inventory as additional roots for an explicit sandbox selection', () => {
  mock.projects = [project('/project', 'agent')];
  mock.sandbox = { type: 'readOnly', networkAccess: false };
  open();
  fireEvent.click(screen.getByRole('button', { name: 'workspaceWrite' }));
  expect(mock.apply).toHaveBeenCalledExactlyOnceWith({
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  });
});

it('recognizes the observed workspace policy without adding other agents copies', () => {
  mock.projects = [project('/project', 'agent')];
  mock.sandbox.writableRoots = [];
  open();
  expect(
    screen.getByRole('button', { name: /workspaceWritecurrent/ }),
  ).toBeEnabled();
  expect(mock.apply).not.toHaveBeenCalled();
});

it('keeps the stored choice distinct from the currently observed sandbox after a restart', () => {
  mock.savedSandbox = { type: 'dangerFullAccess' };
  open();
  expect(
    screen.getByRole('button', { name: /workspaceWritecurrent/ }),
  ).toBeEnabled();
  expect(
    screen.getByRole('button', { name: /dangerFullAccessagentSettingsSaved/ }),
  ).toBeEnabled();
  expect(mock.apply).not.toHaveBeenCalled();
});

it('does not label a rejected request as still applying', () => {
  mock.pending = {
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['/other'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
  mock.outcome = 'rejected';
  open();
  expect(screen.queryByText('applying')).not.toBeInTheDocument();
  expect(
    screen.getByText(
      'thePolicyChangeDidNotTakeEffectThisConversationIsStillOnTheSettingsShownAbove',
    ),
  ).toBeInTheDocument();
  expect(mock.apply).not.toHaveBeenCalled();
});
