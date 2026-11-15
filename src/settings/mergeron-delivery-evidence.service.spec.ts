import { expect, it, vi } from 'vitest';
import { MergeronDeliveryEvidenceService } from './mergeron-delivery-evidence.service';
import { ImageUpdateService } from './image-update.service';
import { ManagerStatusService } from './manager-status.service';
import { accessContext } from '../auth/access-context';
import type {
  IdentityService,
  PlatformIdentity,
} from '../auth/identity.service';
const revision = 'a'.repeat(40),
  digest = 'sha256:' + 'b'.repeat(64),
  imageId = 'sha256:' + 'c'.repeat(64);
function fixture() {
  const published = { revision, digest, imageId, checkedAt: 1700000000000 };
  const component = {
    id: 'application',
    adoption: 'managed',
    imageRepositoryAllowed: true,
    state: 'healthy',
    health: 'healthy',
    imageId,
    build: { revision },
  };
  const images = { publishedCommit: vi.fn(() => Promise.resolve(published)) };
  const manager = {
    status: vi.fn(() =>
      Promise.resolve({
        available: true,
        dockerConnected: true,
        observedAt: new Date().toISOString(),
        environment: 'development',
        components: [component],
      }),
    ),
  };
  let allowed = true;
  const identities = {
    requireAdministrator: vi.fn(() => {
      if (!allowed) throw Error('revoked');
    }),
  };
  const identity: PlatformIdentity = {
    kind: 'person',
    personId: 'admin',
    name: 'Admin',
    active: true,
    role: 'administrator',
  };
  const run = <T>(fn: () => T) =>
    accessContext.run(
      { identity, identities: identities as unknown as IdentityService },
      fn,
    );
  const service = new MergeronDeliveryEvidenceService(
    images as unknown as ImageUpdateService,
    manager as unknown as ManagerStatusService,
  );
  return {
    service,
    published,
    component,
    images,
    manager,
    run,
    revoke: () => {
      allowed = false;
    },
  };
}
it('requires an authenticated current administrator before any registry or Manager read', async () => {
  const f = fixture();
  expect(await f.service.read(revision, () => {})).toMatchObject({
    image: { state: 'unverified', reason: 'administrator_required' },
  });
  f.revoke();
  expect(await f.run(() => f.service.read(revision, () => {}))).toMatchObject({
    deployment: { state: 'unverified', reason: 'administrator_required' },
  });
  expect(f.images.publishedCommit).not.toHaveBeenCalled();
  expect(f.manager.status).not.toHaveBeenCalled();
});
it('links the exact registry image to a healthy managed running image in the attached environment', async () => {
  const f = fixture();
  expect(await f.run(() => f.service.read(revision, () => {}))).toMatchObject({
    image: {
      state: 'verified',
      reason: 'verified_registry',
      revision,
      imageId,
      reference: `ghcr.io/maxhugit/mergeron@${digest}`,
    },
    deployment: {
      state: 'verified',
      reason: 'verified_manager',
      revision,
      imageId,
      environment: 'development',
    },
  });
});
it.each([
  [
    'different_commit',
    (f: ReturnType<typeof fixture>) => {
      f.component.build.revision = 'd'.repeat(40);
    },
  ],
  [
    'runtime_not_healthy',
    (f: ReturnType<typeof fixture>) => {
      f.component.health = 'unhealthy';
    },
  ],
  [
    'image_identity_mismatch',
    (f: ReturnType<typeof fixture>) => {
      f.component.imageId = 'sha256:' + 'e'.repeat(64);
    },
  ],
] as const)('does not claim deployment for %s', async (reason, change) => {
  const f = fixture();
  change(f);
  expect(await f.run(() => f.service.read(revision, () => {}))).toMatchObject({
    image: { state: 'verified' },
    deployment: { state: 'unverified', reason },
  });
});
it('never promotes an unapproved container, missing registry proof or a revoked identity', async () => {
  const f = fixture();
  f.component.adoption = 'adoptable';
  expect(await f.run(() => f.service.read(revision, () => {}))).toMatchObject({
    deployment: { state: 'unverified' },
  });
  f.component.adoption = 'managed';
  f.images.publishedCommit.mockRejectedValue(
    new Error('private registry secret'),
  );
  const result = await f.run(() => f.service.read(revision, () => {}));
  expect(result).toMatchObject({
    image: { state: 'unverified' },
    deployment: { state: 'unverified', reason: 'registry_unavailable' },
  });
  expect(JSON.stringify(result)).not.toContain('private registry secret');
  f.images.publishedCommit.mockImplementation(() => {
    f.revoke();
    return Promise.resolve(f.published);
  });
  const calls = f.manager.status.mock.calls.length;
  expect(await f.run(() => f.service.read(revision, () => {}))).toMatchObject({
    image: { reason: 'administrator_required' },
    deployment: { reason: 'administrator_required' },
  });
  expect(f.manager.status.mock.calls).toHaveLength(calls);
});
it('preserves image evidence when the Manager is unavailable without exposing its error', async () => {
  const f = fixture();
  f.manager.status.mockRejectedValue(new Error('/private/socket secret'));
  const result = await f.run(() => f.service.read(revision, () => {}));
  expect(result).toMatchObject({
    image: { state: 'verified' },
    deployment: { state: 'unverified', reason: 'manager_unavailable' },
  });
  expect(JSON.stringify(result)).not.toContain('secret');
});

it.each([false, true])(
  'rejects a disconnected or stale Manager snapshot (stale: %s)',
  async (stale) => {
    const f = fixture();
    f.manager.status.mockResolvedValue({
      available: true,
      dockerConnected: stale,
      observedAt: new Date(Date.now() - (stale ? 120000 : 0)).toISOString(),
      environment: 'development',
      components: [f.component],
    });
    expect(await f.run(() => f.service.read(revision, () => {}))).toMatchObject(
      {
        image: { state: 'verified' },
        deployment: { state: 'unverified', reason: 'manager_unavailable' },
      },
    );
  },
);
