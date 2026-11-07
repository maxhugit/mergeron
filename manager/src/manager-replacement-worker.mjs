import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerClient } from './docker-client.mjs';
import {
  saveReplacement,
  replacementFingerprint,
} from './manager-replacement.mjs';
import { publishMonitor } from './update-monitor-journal.mjs';
import { probeManagerReadiness } from './health-probe.mjs';

export async function runManagerReplacement({
  docker,
  directory = '/state',
  id,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 180000,
  appTimeoutMs = 6 * 3600000,
  probe,
}) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('updateReplacementInvalid');
  const path = join(directory, 'replacements', id + '.json');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new Error('updateReplacementInvalid');
  const job = JSON.parse(await readFile(path, 'utf8'));
  if (
    job.id !== id ||
    !/^mergeron(?:-[a-z0-9-]+)?$/.test(job.stack) ||
    !/^ghcr.io\/maxhugit\/mergeron-manager@sha256:[a-f0-9]{64}$/.test(job.image)
  )
    throw new Error('updateReplacementInvalid');
  const readinessProbe =
    probe ??
    (() =>
      probeManagerReadiness({
        socketPath: '/manager-run/manager.sock',
        stack: job.stack,
      }));
  // Cleanup is deliberately outside rollback: success is durable before deletion.
  // Only the exact stopped original recorded by this replacement is eligible.
  const cleanupSuccessfulManager = async () => {
    if (job.cleanupStatus === 'complete') return;
    try {
      const currentOperation = JSON.parse(
        await readFile(join(directory, 'updates', 'transaction.json'), 'utf8'),
      );
      if (
        currentOperation.id !== job.operationId ||
        currentOperation.status !== 'succeeded'
      )
        throw new Error('updateReplacementOperationChanged');
      const active = await docker.inspectContainer(job.candidateId);
      if (
        active.Name !== '/' + job.stack + '-manager' ||
        active.Image !== job.targetImageId ||
        active.Config.Labels?.['io.mergeron.replacement'] !== id ||
        replacementFingerprint(active.HostConfig) !==
          replacementFingerprint(job.original.HostConfig) ||
        !active.State.Running ||
        active.State.Health?.Status !== 'healthy' ||
        !(await readinessProbe()).healthy
      )
        throw new Error('updateManagerCleanupNotReady');
      let old;
      try {
        old = await docker.inspectContainer(job.originalId);
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
      if (old) {
        if (
          old.Id === active.Id ||
          old.State.Running ||
          old.Name !== '/' + job.stack + '-manager-previous-' + id ||
          old.Image !== job.original.Image ||
          replacementFingerprint(old.HostConfig) !==
            replacementFingerprint(job.original.HostConfig) ||
          replacementFingerprint(old.Config.Labels) !==
            replacementFingerprint(job.original.Labels)
        )
          throw new Error('updateManagerCleanupIdentityChanged');
        // DockerClient enforces force=false and v=false: never delete volumes.
        await docker.removeContainer(old.Id);
      }
      job.cleanupStatus = 'complete';
      await saveReplacement(path, job);
    } catch {
      job.cleanupStatus = 'pending';
      await saveReplacement(path, job).catch(() => {});
      console.error('updateManagerCleanupDeferred');
    }
  };
  if (['cancelled'].includes(job.stage)) return job;
  let operation;
  if (['succeeded', 'rolledBack', 'recoveryRequired'].includes(job.stage)) {
    operation = JSON.parse(
      await readFile(join(directory, 'updates', 'transaction.json'), 'utf8'),
    );
    if (operation.id !== job.operationId) return job;
    if (job.stage === 'succeeded') await cleanupSuccessfulManager();
    await publishMonitor(join(directory, 'maintenance'), {
      ...operation,
      managerPending: false,
      phase: job.stage === 'succeeded' ? 'complete' : 'recoveryRequired',
      status: job.stage === 'succeeded' ? 'succeeded' : 'recoveryRequired',
    });
    return job;
  }
  const publish = async (phase, status = 'running') => {
    operation = {
      ...operation,
      phase,
      status,
      events: [
        ...(operation?.events ?? []),
        { at: new Date(now()).toISOString(), phase, status },
      ],
    };
    if (operation.id !== job.operationId) return job;
    await publishMonitor(join(directory, 'maintenance'), {
      ...operation,
      managerPending: false,
    });
  };
  if (job.stage === 'waiting') {
    const deadline = now() + appTimeoutMs;
    while (now() < deadline) {
      try {
        const current = JSON.parse(
          await readFile(
            join(directory, 'updates', 'transaction.json'),
            'utf8',
          ),
        );
        if (current.id === job.operationId) {
          operation = current;
          if (current.status === 'succeeded') {
            const projection = JSON.parse(
              await readFile(
                join(directory, 'maintenance', 'state.json'),
                'utf8',
              ),
            );
            if (
              projection.operation?.id === job.operationId &&
              projection.operation.phase === 'managerPending'
            )
              break;
          }
          if (current.status !== 'running' && current.status !== 'succeeded') {
            job.stage = 'cancelled';
            await saveReplacement(path, job);
            return job;
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await sleep(1000);
    }
    if (operation?.id !== job.operationId || operation.status !== 'succeeded')
      throw new Error('updateReplacementApplicationIncomplete');
  } else
    operation = JSON.parse(
      await readFile(join(directory, 'updates', 'transaction.json'), 'utf8'),
    );
  if (operation.id !== job.operationId)
    throw new Error('updateReplacementOperationChanged');
  const canonical = job.stack + '-manager';
  const retained = canonical + '-previous-' + id;
  try {
    await publish('managerReplacing');
    const old = await docker.inspectContainer(job.originalId);
    if (
      !['/' + canonical, '/' + retained].includes(old.Name) ||
      old.Image !== job.original.Image ||
      replacementFingerprint(old.HostConfig) !==
        replacementFingerprint(job.original.HostConfig)
    )
      throw new Error('updateManagerIdentityChanged');
    job.originalTouched = true;
    job.stage = 'replacing';
    await saveReplacement(path, job);
    if (old.Name === '/' + canonical)
      await docker.renameContainer(job.originalId, retained);
    if (old.State.Running) await docker.stopContainer(job.originalId);
    let candidate;
    try {
      candidate = await docker.inspectContainer(canonical);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
    if (
      candidate &&
      candidate.Config.Labels?.['io.mergeron.replacement'] !== id
    )
      throw new Error('updateManagerNameConflict');
    if (!candidate) {
      const created = await docker.createContainer(canonical, {
        ...job.original,
        Image: job.targetImageId,
        Labels: { ...job.original.Labels, 'io.mergeron.replacement': id },
      });
      job.candidateId = created.Id;
      await saveReplacement(path, job);
      candidate = await docker.inspectContainer(created.Id);
    } else {
      job.candidateId = candidate.Id;
      await saveReplacement(path, job);
    }
    if (candidate.Image !== job.targetImageId)
      throw new Error('updateManagerImageInvalid');
    if (!candidate.State.Running) await docker.startContainer(candidate.Id);
    await publish('managerChecking');
    let healthy = false;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const inspect = await docker.inspectContainer(candidate.Id);
      if (
        !inspect.State.Running ||
        inspect.State.Health?.Status === 'unhealthy'
      )
        throw new Error('updateManagerHealthFailed');
      if (
        inspect.State.Health?.Status === 'healthy' &&
        (await readinessProbe()).healthy
      ) {
        healthy = true;
        break;
      }
      await sleep(1000);
    }
    if (!healthy) throw new Error('updateManagerHealthTimeout');
    job.stage = 'succeeded';
    await saveReplacement(path, job);
  } catch {
    if (!job.originalTouched) {
      job.stage = 'recoveryRequired';
      await saveReplacement(path, job);
      await publish('recoveryRequired', 'recoveryRequired');
      return job;
    }
    try {
      if (job.candidateId) {
        const candidate = await docker.inspectContainer(job.candidateId);
        if (
          candidate.Config.Labels?.['io.mergeron.replacement'] !== id ||
          candidate.Name !== '/' + canonical ||
          candidate.Image !== job.targetImageId ||
          replacementFingerprint(candidate.HostConfig) !==
            replacementFingerprint(job.original.HostConfig)
        )
          throw new Error('updateManagerIdentityChanged');
        if (candidate.State.Running) await docker.stopContainer(candidate.Id);
        await docker.removeContainer(candidate.Id);
      }
      const old = await docker.inspectContainer(job.originalId);
      if (
        old.Image !== job.original.Image ||
        replacementFingerprint(old.HostConfig) !==
          replacementFingerprint(job.original.HostConfig)
      )
        throw new Error('updateManagerIdentityChanged');
      if (old.Name === '/' + retained)
        await docker.renameContainer(old.Id, canonical);
      else if (old.Name !== '/' + canonical)
        throw new Error('updateManagerIdentityChanged');
      if (!old.State.Running) await docker.startContainer(old.Id);
      job.stage = 'rolledBack';
      await saveReplacement(path, job);
      // The application may already be newer: do not claim a complete stack rollback.
      await publish('managerRolledBack', 'recoveryRequired');
    } catch {
      job.stage = 'recoveryRequired';
      await saveReplacement(path, job);
      await publish('recoveryRequired', 'recoveryRequired');
    }
    return job;
  }
  await cleanupSuccessfulManager();
  await publish('complete', 'succeeded');
  return job;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runManagerReplacement({
      docker: new DockerClient(),
      id: process.argv[2],
    });
    // The existing on-failure helper policy retries deferred cleanup (max 3 restarts).
    if (result.stage === 'succeeded' && result.cleanupStatus === 'pending')
      process.exitCode = 1;
  } catch {
    console.error('updateManagerReplacementFailed');
    process.exitCode = 1;
  }
}
