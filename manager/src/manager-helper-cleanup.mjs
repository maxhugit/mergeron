import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  replacementFingerprint,
  saveReplacement,
} from './manager-replacement.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const worker = ['/nodejs/bin/node', 'src/manager-replacement-worker.mjs'];
const same = (a, b) => replacementFingerprint(a) === replacementFingerprint(b);

/** Only terminal, successful replacement helpers; never a general Docker prune. */
export class ManagerHelperCleanup {
  constructor({ docker, directory, stack, blocked, probe }) {
    Object.assign(this, { docker, directory, stack, blocked, probe });
    this.status = { retained: 0, unavailable: false };
  }
  tick() {
    if (this.task) return this.task;
    this.task = this.run()
      .catch(() => {
        this.status = { ...this.status, unavailable: true };
      })
      .finally(() => {
        this.task = null;
      });
    return this.task;
  }
  async run() {
    if (await this.blocked()) return;
    let retained = 0;
    try {
      const helpers = (await this.docker.listContainers()).filter(
        (c) =>
          c.Labels?.['io.mergeron.stack'] === this.stack &&
          c.Labels?.['io.mergeron.component'] === 'managerReplacement',
      );
      for (const helper of helpers.slice(0, 100)) {
        try {
          if (await this.blocked()) break;
          const stopped = await this.docker.inspectContainer(helper.Id);
          if (stopped.State.Running || stopped.State.Restarting) continue;
          const id = stopped.Config.Labels?.['io.mergeron.replacement'];
          if (
            !uuid.test(id ?? '') ||
            stopped.Name !== `/${this.stack}-manager-replacement-${id}` ||
            stopped.Config.Labels?.['io.mergeron.stack'] !== this.stack ||
            stopped.Config.Labels?.['io.mergeron.component'] !==
              'managerReplacement'
          )
            continue;
          const path = join(this.directory, 'replacements', id + '.json');
          const info = await lstat(path);
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.size > 1024 * 1024
          )
            throw new Error('helperJournalInvalid');
          const job = JSON.parse(await readFile(path, 'utf8'));
          if (
            job.id !== id ||
            job.stack !== this.stack ||
            job.stage !== 'succeeded' ||
            job.cleanupStatus !== 'complete' ||
            stopped.State.ExitCode !== 0 ||
            stopped.Image !== job.original.Image ||
            !same(stopped.Config.Entrypoint, worker) ||
            !same(stopped.Config.Cmd, [id]) ||
            stopped.HostConfig.NetworkMode !== 'none' ||
            !stopped.HostConfig.ReadonlyRootfs
          )
            throw new Error('helperNotCompleted');
          const ready = async () => {
            if (await this.blocked()) throw new Error('helperOperationBusy');
            const operation = JSON.parse(
              await readFile(
                join(this.directory, 'updates', 'transaction.json'),
                'utf8',
              ),
            );
            const active = await this.docker.inspectContainer(
              `${this.stack}-manager`,
            );
            if (
              operation.id !== job.operationId ||
              operation.status !== 'succeeded' ||
              active.Id !== job.candidateId ||
              active.Name !== `/${this.stack}-manager` ||
              active.Image !== job.targetImageId ||
              active.Config.Labels?.['io.mergeron.stack'] !== this.stack ||
              active.Config.Labels?.['io.mergeron.component'] !== 'manager' ||
              active.Config.Labels?.['io.mergeron.managed'] !== 'true' ||
              active.Config.Labels?.['io.mergeron.replacement'] !== id ||
              !same(active.HostConfig, job.original.HostConfig) ||
              !active.State.Running ||
              active.State.Health?.Status !== 'healthy' ||
              !(await this.probe()).healthy
            )
              throw new Error('helperManagerNotReady');
          };
          await ready();
          // Preserve the bounded Docker log before removing its only Docker copy.
          const directory = join(this.directory, 'replacements', 'helper-logs');
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const logDirectory = await lstat(directory);
          if (!logDirectory.isDirectory() || logDirectory.isSymbolicLink())
            throw new Error('helperLogInvalid');
          const logs = await this.docker.containerLogs(stopped.Id);
          if (typeof logs !== 'string' || Buffer.byteLength(logs) > 128 * 1024)
            throw new Error('helperLogInvalid');
          await saveReplacement(join(directory, id + '.json'), {
            helperId: stopped.Id,
            replacementId: id,
            logs,
          });
          await ready();
          const current = await this.docker.inspectContainer(stopped.Id);
          if (!same(current, stopped)) throw new Error('helperIdentityChanged');
          // DockerClient always uses force=false and v=false. Never stop a helper.
          await this.docker.removeContainer(stopped.Id);
        } catch {
          retained++;
        }
      }
      this.status = { retained, unavailable: false };
    } catch {
      this.status = { retained, unavailable: true };
    }
  }
}
