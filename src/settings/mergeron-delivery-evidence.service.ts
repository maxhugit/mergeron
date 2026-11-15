/** Read-only registry + attached Manager observations for Mergeron itself. No update, pull or deployment. */
import { Injectable } from '@nestjs/common';
import { currentAccess } from '../auth/access-context';
import { ImageUpdateService } from './image-update.service';
import { ManagerStatusService } from './manager-status.service';
import type { DeliveryEvidence } from './delivery-evidence';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const revisionPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const unknown = (reason: DeliveryEvidence['reason']): DeliveryEvidence => ({
  state: 'unverified',
  reason,
});
@Injectable()
export class MergeronDeliveryEvidenceService {
  constructor(
    private readonly images: ImageUpdateService,
    private readonly manager: ManagerStatusService,
  ) {}
  async read(
    revision: string,
    assertActive: () => void,
  ): Promise<{ image: DeliveryEvidence; deployment: DeliveryEvidence }> {
    const authorize = () => {
      assertActive();
      const access = currentAccess();
      if (!access) throw Error('Administrator access required');
      access.identities.requireAdministrator(access.identity);
    };
    try {
      authorize();
    } catch {
      return {
        image: unknown('administrator_required'),
        deployment: unknown('administrator_required'),
      };
    }
    let image: DeliveryEvidence = unknown('registry_unavailable');
    let imageId: string | undefined;
    try {
      const published = await this.images.publishedCommit(revision);
      authorize();
      if (
        !digestPattern.test(published.imageId) ||
        !digestPattern.test(published.digest) ||
        published.revision !== revision
      )
        throw Error('IMAGE_COMMIT_MISMATCH');
      imageId = published.imageId;
      image = {
        state: 'verified',
        reason: 'verified_registry',
        revision,
        checkedAt: published.checkedAt,
        imageId,
        reference: `ghcr.io/maxhugit/mergeron@${published.digest}`,
      };
    } catch (error) {
      image = unknown(
        error instanceof Error && error.message === 'IMAGE_COMMIT_MISMATCH'
          ? 'commit_mismatch'
          : 'registry_unavailable',
      );
    }
    let deployment: DeliveryEvidence = unknown('manager_unavailable');
    try {
      authorize();
      const status = object(await this.manager.status());
      authorize();
      const components = Array.isArray(status.components)
        ? status.components.map(object).filter((c) => c.id === 'application')
        : [];
      const observedAt =
        typeof status.observedAt === 'string'
          ? Date.parse(status.observedAt)
          : NaN;
      if (
        status.available !== true ||
        status.dockerConnected !== true ||
        components.length !== 1 ||
        !Number.isFinite(observedAt) ||
        observedAt > Date.now() + 5000 ||
        Date.now() - observedAt > 60000
      )
        return { image, deployment };
      const component = components[0];
      if (
        component.adoption !== 'managed' ||
        component.imageRepositoryAllowed !== true
      )
        return { image, deployment };
      const observed = object(component.build).revision;
      const observedRevision =
        typeof observed === 'string' && revisionPattern.test(observed)
          ? observed
          : null;
      const environment =
        status.environment === 'production' ||
        status.environment === 'development'
          ? status.environment
          : 'unknown';
      const observation = {
        checkedAt: observedAt,
        observedRevision,
        environment,
      } as const;
      if (observedRevision !== revision)
        deployment = { ...unknown('different_commit'), ...observation };
      else if (component.state !== 'healthy' || component.health !== 'healthy')
        deployment = { ...unknown('runtime_not_healthy'), ...observation };
      else if (!imageId || image.state !== 'verified')
        deployment = { ...unknown('registry_unavailable'), ...observation };
      else if (component.imageId !== imageId)
        deployment = { ...unknown('image_identity_mismatch'), ...observation };
      else
        deployment = {
          state: 'verified',
          reason: 'verified_manager',
          ...observation,
          revision,
          imageId,
          reference: image.reference,
        };
      return { image, deployment };
    } catch {
      /* Availability failures do not erase separately observed registry evidence. */
    }
    try {
      authorize();
    } catch {
      return {
        image: unknown('administrator_required'),
        deployment: unknown('administrator_required'),
      };
    }
    return { image, deployment };
  }
}
