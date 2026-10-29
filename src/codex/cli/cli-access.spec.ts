/** CLI lifecycle routes must never be available to standard users, including read/check actions. */
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { expect, it, vi } from 'vitest';
import { PlatformAccessGuard } from '../../auth/platform-access.guard';
import type { IdentityService } from '../../auth/identity.service';
import type { AuthService } from '../../auth/auth.service';

it.each([
  ['GET', '/api/codex/cli?refresh=true'],
  ['POST', '/api/codex/cli/update'],
  ['POST', '/api/codex/cli/rollback'],
  ['POST', '/api/codex/cli/managed'],
])('requires administrator access for %s %s', (method, url) => {
  let role = 'standard';
  const identities = {
    resolve: () => ({ role }),
    requireActive: vi.fn(),
    requireAdministrator: () => {
      throw new ForbiddenException();
    },
  };
  const context = {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => Object,
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        url,
        headers: {},
        body: { role: 'administrator' },
      }),
    }),
  } as unknown as ExecutionContext;
  const guard = new PlatformAccessGuard(
    identities as unknown as IdentityService,
    new Reflector(),
    {} as AuthService,
  );
  expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  role = 'administrator';
  expect(guard.canActivate(context)).toBe(true);
});
