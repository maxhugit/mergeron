import { SettingsController } from './settings.controller';
import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import { ManagerStatusService } from './manager-status.service';
import { RegistryImageIdentityService } from './registry-image-identity.service';

const oldId = `sha256:${'a'.repeat(64)}`;
const nextId = `sha256:${'b'.repeat(64)}`;
function fixture() {
  const imageId = vi.fn().mockResolvedValue(oldId);
  const candidate = {
    id: 'ingress',
    installedImageId: oldId,
    installedDigest: oldId,
    targetImage: 'nginx:stable',
    targetDigest: nextId,
    platform: { os: 'linux', architecture: 'amd64' },
    platformCheckRequired: true,
    updateAvailable: false,
    checkError: 'platformIdentityUnavailable',
  };
  class Bridge extends ManagerStatusService {
    protected override requestManager() {
      return Promise.resolve({ components: [candidate] });
    }
  }
  return {
    imageId,
    candidate,
    service: new Bridge(new ConfigService(), {
      imageId,
    } as unknown as RegistryImageIdentityService),
  };
}
it('suppresses the Nginx false alert when the index changes but the runnable image is identical', async () => {
  const { service, imageId } = fixture();
  expect(await service.imageUpdates(true)).toMatchObject({
    components: [
      {
        updateAvailable: false,
        versionStatus: 'current',
        checkError: null,
        targetImageId: oldId,
      },
    ],
  });
  expect(imageId).toHaveBeenCalledWith('ingress', 'nginx:stable', nextId, {
    os: 'linux',
    architecture: 'amd64',
  });
});
it('offers a real platform rebuild, even with the same upstream version, pinned to the checked digest', async () => {
  const { service, imageId } = fixture();
  imageId.mockResolvedValue(nextId);
  expect(await service.imageUpdates()).toMatchObject({
    components: [
      {
        updateAvailable: true,
        versionStatus: 'update_available',
        targetDigest: nextId,
        checkError: null,
      },
    ],
  });
});
it('fails closed on filtered network errors and never turns them into up-to-date or update available', async () => {
  const { service, imageId } = fixture();
  imageId.mockRejectedValue(new Error('private registry diagnostic'));
  const result = await service.imageUpdates();
  expect(result).toMatchObject({
    components: [
      {
        updateAvailable: false,
        versionStatus: 'unknown',
        checkError: 'platformIdentityUnavailable',
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('private registry diagnostic');
});
it('does not conceal a Manager registry error', async () => {
  const { service, candidate, imageId } = fixture();
  candidate.checkError = 'registryUnavailable';
  expect(await service.imageUpdates()).toMatchObject({
    components: [{ checkError: 'registryUnavailable' }],
  });
  expect(imageId).not.toHaveBeenCalled();
});
it('requires a new Manager platform identity instead of trusting an old index-only comparison', async () => {
  const { service, candidate, imageId } = fixture();
  candidate.installedImageId = '';
  candidate.updateAvailable = true;
  expect(await service.imageUpdates()).toMatchObject({
    components: [{ updateAvailable: false, versionStatus: 'unknown' }],
  });
  expect(imageId).not.toHaveBeenCalled();
});

it('builds a global plan from fresh verified discovery and ignores client-selected images', async () => {
  const requests = vi.fn().mockResolvedValue({ applicable: true });
  class Bridge extends ManagerStatusService {
    override imageUpdates = vi.fn().mockResolvedValue({
      components: [
        {
          id: 'application',
          updateAvailable: true,
          targetImage: 'ghcr.io/maxhugit/mergeron:edge',
          targetDigest: nextId,
        },
        { id: 'ingress', versionStatus: 'current', updateAvailable: false },
        {
          id: 'manager',
          updateAvailable: true,
          targetImage: 'ghcr.io/maxhugit/mergeron-manager:edge',
          targetDigest: nextId,
        },
      ],
    });
    protected override requestManager = requests;
  }
  const service = new Bridge(new ConfigService());
  await service.updateOperation('plan', {
    automatic: true,
    images: { ingress: 'nginx:untrusted' },
    backupMode: 'minimal',
  });
  expect(service.imageUpdates).toHaveBeenCalledWith(true);
  expect(requests).toHaveBeenCalledWith(
    '/v1/update/plan',
    'POST',
    expect.objectContaining({
      images: {
        application: `ghcr.io/maxhugit/mergeron@${nextId}`,
        manager: `ghcr.io/maxhugit/mergeron-manager@${nextId}`,
      },
      backupMode: 'minimal',
    }),
  );
});

it('blocks a global plan when a managed component has unknown registry identity', async () => {
  class Bridge extends ManagerStatusService {
    override imageUpdates = vi.fn().mockResolvedValue({
      components: [
        { id: 'ingress', versionStatus: 'unknown', checkError: 'offline' },
      ],
    });
  }
  await expect(
    new Bridge(new ConfigService()).updateOperation('plan', {
      automatic: true,
    }),
  ).rejects.toThrow('updateDiscoveryIncomplete');
});

it('does not let an HTTP caller restore per-container selection by disabling automatic planning', async () => {
  const updateOperation = vi.fn().mockResolvedValue({ applicable: true });
  const controller = new SettingsController(
    {} as ConstructorParameters<typeof SettingsController>[0],
    { updateOperation } as unknown as ManagerStatusService,
    {} as ConstructorParameters<typeof SettingsController>[2],
  );
  await controller.managerUpdatePlan({
    automatic: false,
    images: { ingress: 'nginx:unreviewed' },
    backupMode: 'minimal',
  });
  expect(updateOperation).toHaveBeenCalledWith(
    'plan',
    expect.objectContaining({ automatic: true, backupMode: 'minimal' }),
  );
});

it('forwards the reviewed manual backup mode through the controller without replacing it by full', async () => {
  const updateOperation = vi.fn().mockResolvedValue({ applicable: true });
  const controller = new SettingsController(
    {} as ConstructorParameters<typeof SettingsController>[0],
    { updateOperation } as unknown as ManagerStatusService,
    {} as ConstructorParameters<typeof SettingsController>[2],
  );
  await controller.managerCheckpointPlan({ backupMode: 'essential' });
  expect(updateOperation).toHaveBeenLastCalledWith('checkpoint-plan', {
    backupMode: 'essential',
  });
  await controller.managerCheckpoint(
    {
      backupMode: 'essential',
      confirmation: 'CREATE_BACKUP',
      expectedFingerprint: 'reviewed',
    },
    {} as Parameters<typeof controller.managerCheckpoint>[1],
  );
  expect(updateOperation).toHaveBeenLastCalledWith(
    'checkpoint',
    expect.objectContaining({
      backupMode: 'essential',
      confirmation: 'CREATE_BACKUP',
      expectedFingerprint: 'reviewed',
    }),
  );
});
