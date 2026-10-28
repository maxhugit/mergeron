import { beforeEach, expect, it, vi } from 'vitest';
import { LocalBrowserController } from './local-browser.controller';
import { LocalBrowserService } from './local-browser.service';
import type { IdentityService } from '../auth/identity.service';
import type { IdentityRequest } from '../auth/platform-access.guard';

const checks = {
  requireActive: vi.fn(),
  requireAdministrator: vi.fn(),
  requireThread: vi.fn(),
};
let controller: LocalBrowserController;
const request = (identity: Record<string, unknown> = { personId: 'alice' }) =>
  ({ platformIdentity: identity }) as unknown as IdentityRequest;
beforeEach(() => {
  for (const check of Object.values(checks)) check.mockReset();
  controller = new LocalBrowserController(
    new LocalBrowserService(),
    checks as unknown as IdentityService,
  );
});
it('requires authentication and refuses impersonation before opening any session', () => {
  expect(() => controller.open('agent', {} as IdentityRequest)).toThrow(
    'unavailable',
  );
  expect(() =>
    controller.open('agent', request({ personId: 'alice', impersonation: {} })),
  ).toThrow('unavailable');
});
it('revalidates active administrator and thread access on every endpoint, not only pairing', () => {
  const req = request();
  const { id } = controller.open('agent', req);
  checks.requireAdministrator.mockImplementation(() => {
    throw Error('ADMIN_ONLY');
  });
  for (const invoke of [
    () => controller.status('agent', req),
    () => controller.poll('agent', id, { state: 'shared' }, req),
    () =>
      controller.decide('agent', id, { commandId: 'c', approve: true }, req),
    () => controller.close('agent', id, req),
  ])
    expect(invoke).toThrow('ADMIN_ONLY');
  checks.requireAdministrator.mockReset();
  checks.requireThread.mockImplementation(() => {
    throw Error('THREAD_DENIED');
  });
  expect(() => controller.status('agent', req)).toThrow('THREAD_DENIED');
  expect(checks.requireActive).toHaveBeenCalledTimes(6);
});
it('does not let an authenticated second owner access an existing session', () => {
  const { id } = controller.open('agent', request());
  expect(() =>
    controller.poll(
      'agent',
      id,
      { state: 'paused' },
      request({ personId: 'bob' }),
    ),
  ).toThrow('unavailable');
});
