import { AsyncLocalStorage } from 'node:async_hooks';
import type { IdentityService, PlatformIdentity } from './identity.service';

/** Request-local authorization; background jobs do not borrow a browser identity. */
export const accessContext = new AsyncLocalStorage<{
  identity: PlatformIdentity;
  identities: IdentityService;
  /** Trusted origin of work requested by a local agent; never accepted from request bodies. */
  localAgentThreadId?: string;
}>();

export function currentAccess() {
  return accessContext.getStore();
}

export function requireProjectAccess(projectId: string) {
  const access = currentAccess();
  if (access) access.identities.requireProject(access.identity, projectId);
}

export function canReadProject(projectId: string) {
  const access = currentAccess();
  return (
    !access || access.identities.canReadProject(access.identity, projectId)
  );
}

export function canReadThread(id: string, kind: 'agent' | 'simple' = 'agent') {
  const access = currentAccess();
  return !access || access.identities.canReadThread(access.identity, id, kind);
}

export function requireThreadAccess(
  id: string,
  kind: 'agent' | 'simple' = 'agent',
) {
  const access = currentAccess();
  if (access) access.identities.requireThread(access.identity, id, kind);
}

export function requireExecutionAccess() {
  const access = currentAccess();
  if (access) access.identities.requireAdministrator(access.identity);
}
