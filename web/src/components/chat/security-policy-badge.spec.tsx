import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SecurityPolicyBadge } from './security-policy-badge';

const mock = vi.hoisted(() => ({
  available: true,
  stale: false,
  apply: vi.fn(),
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
  useTimelineStore: () => '/project/copy',
}));
vi.mock('@/hooks/use-thread-security-policy', () => ({
  useThreadSecurityPolicy: () => ({
    observed: {
      observed: true,
      approvalPolicy: 'never',
      sandboxPolicy: mock.sandbox,
    },
    apply: mock.apply,
    pending: null,
    isSettling: false,
    stale: mock.stale,
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data:
      queryKey[0] === 'agent-test-profile'
        ? { available: mock.available }
        : { projects: [] },
  }),
}));
beforeEach(() => {
  mock.apply.mockReset();
  mock.available = true;
  mock.stale = false;
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
