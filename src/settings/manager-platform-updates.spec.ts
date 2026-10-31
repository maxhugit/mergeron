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
