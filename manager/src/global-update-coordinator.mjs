import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replacementFingerprint } from './manager-replacement.mjs';

export class GlobalUpdateCoordinator {
  constructor({ updater, replacement, docker, stack }) {
    Object.assign(this, { updater, replacement, docker, stack });
    updater.prepareManager = async (operation) => {
      const plan = await replacement.plan(operation.managerTarget);
      if (plan.fingerprint !== operation.managerFingerprint)
        throw new Error('updatePlanChanged');
      await replacement.launch(plan, operation.id);
    };
  }
  async status() {
    const status = this.updater.status();
    if (!this.updater.current?.managerPending) return status;
    try {
      const state = JSON.parse(
        await readFile(
          join(this.replacement.directory, 'maintenance', 'state.json'),
          'utf8',
        ),
      );
      if (state.operation?.id === status.operation?.id)
        return {
          ...status,
          busy: state.operation.status === 'running',
          operation: {
            ...status.operation,
            ...state.operation,
            rollbackAvailable: false,
          },
        };
    } catch {
      /* A missing projection must never turn a pending Manager into success. */
    }
    return {
      ...status,
      busy: true,
      operation: {
        ...status.operation,
        status: 'running',
        phase: 'managerPending',
        rollbackAvailable: false,
      },
    };
  }
  async details(images, mode, backupMode) {
    if (!images || typeof images !== 'object' || Array.isArray(images))
      throw new Error('updateInvalidImages');
    const { manager, ...applicationImages } = images;
    if (!manager)
      return {
        base: await this.updater.plan(images, mode, backupMode),
        manager: null,
      };
    const replacement = await this.replacement.plan(manager);
    // A manager-only update still uses the existing reviewed backup/health transaction.
    if (!Object.keys(applicationImages).length) {
      const current = await this.docker.inspectContainer(this.stack + '-ui');
      const image = await this.docker.inspectImage(current.Image);
      const pinned = image.RepoDigests?.find((reference) =>
        /^ghcr.io\/maxhugit\/(?:mergeron|codex-webui-unraid)@sha256:[a-f0-9]{64}$/.test(
          reference,
        ),
      );
      if (!pinned) throw new Error('updateApplicationIdentityUnknown');
      applicationImages.application = pinned;
    }
    return {
      base: await this.updater.plan(applicationImages, mode, backupMode),
      manager: replacement,
    };
  }
  async plan(images, mode, backupMode) {
    const { base, manager } = await this.details(images, mode, backupMode);
    if (!manager) return base;
    return {
      ...base,
      images: { ...base.images, manager: manager.image },
      fingerprint: replacementFingerprint({
        stack: base.fingerprint,
        manager: manager.fingerprint,
      }),
      managerReplacement: true,
    };
  }
  async begin(input) {
    if (!input.images?.manager) return this.updater.begin(input);
    const { base, manager } = await this.details(
      input.images,
      input.mode,
      input.backupMode,
    );
    const fingerprint = replacementFingerprint({
      stack: base.fingerprint,
      manager: manager.fingerprint,
    });
    if (fingerprint !== input.expectedFingerprint)
      throw new Error('updatePlanChanged');
    if (base.blockers.length || !base.applicable)
      throw new Error('updateBlocked');
    if (input.confirmation !== base.confirmation)
      throw new Error('updateConfirmationRequired');
    const requestedId = randomUUID();
    return this.updater.begin({
      ...input,
      images: base.images,
      expectedFingerprint: base.fingerprint,
      requestedId,
      managerPending: true,
      managerTarget: manager.image,
      managerFingerprint: manager.fingerprint,
    });
  }
}
