import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { documentSeccompProfile } from './installer.mjs';

const ids = ['browser', 'transcription'];
/** Private durable intent. Never accepts images, mounts, paths or Docker options. */
export class Capabilities {
  task = null;
  error = null;
  operation = null;
  recoveryGrace = new Map();
  desired = { browser: false, transcription: false };
  constructor(options) {
    Object.assign(this, options);
  }
  get busy() {
    return !!this.task;
  }
  async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + '.tmp';
    await writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        desired: this.desired,
        pending: this.operation,
      }),
      { mode: 0o600 },
    );
    await rename(temporary, this.path);
  }
  async initialize() {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'));
      if (
        state.version !== 1 ||
        ids.some((id) => typeof state.desired?.[id] !== 'boolean')
      )
        throw Error('CAPABILITY_STATE_INVALID');
      this.desired = state.desired;
      if (state.pending) this.error = 'CAPABILITY_OPERATION_INTERRUPTED';
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Existing validated companions and explicitly enabled legacy workers survive migration.
      this.desired = {
        browser: !!(await this.browser.inspect().catch(() => ({}))),
        transcription:
          this.transcription.enabled ||
          !!(await this.transcription.current().catch(() => ({}))),
      };
      await this.save();
    }
    this.transcription.enabled = this.desired.transcription;
    this.syncManifest();
    for (const [id, inspect] of [
      ['browser', () => this.browser.inspect()],
      ['transcription', () => this.transcription.current()],
    ]) {
      const item = await inspect().catch(() => null);
      if (item?.State?.Running) this.recoveryGrace.set(id, Date.now() + 90_000);
    }
  }
  syncManifest() {
    const index = this.manifest.components.findIndex((c) => c.id === 'browser');
    if (this.desired.browser && index < 0)
      this.manifest.components.push(this.browser.component);
    if (!this.desired.browser && index >= 0)
      this.manifest.components.splice(index, 1);
  }
  async status() {
    const [browser, transcription] = await Promise.all([
      this.browser.status(),
      this.transcription.status(),
    ]);
    return {
      operation: this.operation,
      error: this.error,
      capabilities: ids.map((id) => ({
        id,
        installed: this.desired[id],
        state:
          this.operation?.id === id
            ? this.operation.action === 'install'
              ? 'installing'
              : 'uninstalling'
            : !this.desired[id]
              ? 'notInstalled'
              : { browser, transcription }[id].state,
        activeLeases: { browser, transcription }[id].activeLeases ?? 0,
      })),
    };
  }
  async change(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !['id', 'action', 'confirmation'].includes(k),
      ) ||
      !ids.includes(input.id) ||
      !['install', 'uninstall'].includes(input.action) ||
      input.confirmation !== `${input.action}:${input.id}`
    )
      throw Error('CAPABILITY_CONFIRMATION_REQUIRED');
    if (this.busy || (await this.blocked())) throw Error('CAPABILITY_BUSY');
    if (this.busy) throw Error('CAPABILITY_BUSY');
    this.browser.prune();
    this.transcription.prune();
    if (
      this.browser.busy ||
      this.transcription.busy ||
      this.browser.leases.size
    )
      throw Error('CAPABILITY_IN_USE');
    if (
      input.action === 'uninstall' &&
      Date.now() < (this.recoveryGrace.get(input.id) ?? 0)
    )
      throw Error('CAPABILITY_IN_USE');
    // Both companions are locked against new leases for the complete operation.
    this.operation = { id: input.id, action: input.action };
    this.error = null;
    this.task = this.perform(input)
      .catch((error) => {
        this.error =
          /^(?:CAPABILITY|TRANSCRIPTION|BROWSER_RUNTIME)_[A-Z_]+$/.test(
            error.message ?? '',
          )
            ? error.message
            : 'CAPABILITY_OPERATION_FAILED';
      })
      .finally(() => {
        this.task = null;
        this.operation = null;
      });
    return this.status();
  }
  async perform({ id, action }) {
    // Verify the complete adopted core before permitting any Docker mutation.
    const inventory = await this.inventory();
    if (!(await this.coreTrusted(inventory)))
      throw Error('CAPABILITY_STACK_NOT_ADOPTED');
    await this.save();
    if (action === 'install') {
      if (id === 'browser') await this.installBrowser(inventory);
      else await this.transcription.ensure();
      this.desired[id] = true;
    } else {
      const item =
        id === 'browser'
          ? await this.browser.inspect()
          : await this.transcription.current();
      if (item) {
        const originalId = item.Id;
        if (item.State.Running) await this.docker.stopContainer(originalId, 15);
        // Revalidate identity and isolation after stop; never remove volumes or force deletion.
        const checked =
          id === 'browser'
            ? await this.browser.inspect()
            : await this.transcription.current();
        if (checked?.Id !== originalId || checked.State.Running)
          throw Error('CAPABILITY_CONTAINER_CHANGED');
        await this.docker.removeContainer(originalId);
      }
      this.desired[id] = false;
    }
    this.transcription.enabled = this.desired.transcription;
    this.syncManifest();
    await this.save();
    // An explicit operation may change the optional browser's adoption snapshot only.
    await this.recordAdoption(inventory);
    this.operation = null;
    await this.save();
  }
  async installBrowser(inventory) {
    if (await this.browser.inspect()) return;
    const c = this.browser.component;
    const image =
      'ghcr.io/maxhugit/mergeron-browser:' +
      (this.manifest.environment === 'production' ? 'latest' : 'edge');
    await this.docker.pullImage(image);
    const pinned = (await this.docker.inspectImage(image)).Id;
    for (const name of c.requiredNetworks) {
      let network;
      try {
        network = await this.docker.inspectNetwork(name);
      } catch (e) {
        if (e.statusCode !== 404) throw e;
        await this.docker.createNetwork({
          Name: name,
          Driver: 'bridge',
          Internal: name.endsWith('-browser-control'),
          Labels: {
            'io.mergeron.managed': 'true',
            'io.mergeron.stack': this.manifest.stack,
          },
        });
        network = await this.docker.inspectNetwork(name);
      }
      if (
        network.Driver !== 'bridge' ||
        network.Internal !== name.endsWith('-browser-control')
      )
        throw Error('CAPABILITY_NETWORK_ISOLATION');
    }
    const app = inventory.components.find((c) => c.id === 'application');
    const control = c.requiredNetworks.find((n) =>
      n.endsWith('-browser-control'),
    );
    const currentApp = await this.docker.inspectContainer(app.containerId);
    if (!currentApp.NetworkSettings.Networks[control])
      await this.docker.connectNetwork(control, app.containerId);
    const created = await this.docker.createContainer(c.canonicalName, {
      Image: pinned,
      User: 'pwuser',
      Env: ['BROWSER_WS_PATH=' + randomBytes(32).toString('hex')],
      Labels: {
        'io.mergeron.managed': 'true',
        'io.mergeron.component': 'browser',
        'io.mergeron.stack': this.manifest.stack,
      },
      NetworkingConfig: {
        EndpointsConfig: Object.fromEntries(
          c.requiredNetworks.map((n) => [n, { Aliases: [c.canonicalName] }]),
        ),
      },
      Healthcheck: {
        Test: [
          'CMD',
          'node',
          '-e',
          'const s=require("net").connect(3000,"127.0.0.1",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),3000)',
        ],
        Interval: 10e9,
        Timeout: 5e9,
        Retries: 3,
      },
      HostConfig: {
        Init: true,
        NetworkMode: control,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        Dns: ['1.1.1.1'],
        SecurityOpt: ['no-new-privileges:true', documentSeccompProfile()],
        Memory: 1024 ** 3,
        NanoCpus: 1.5e9,
        PidsLimit: 256,
        ShmSize: 256 * 1024 ** 2,
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=512m,mode=1777' },
        RestartPolicy: { Name: 'no' },
        LogConfig: {
          Type: 'json-file',
          Config: { 'max-size': '2m', 'max-file': '2' },
        },
      },
    });
    const checked = await this.browser.inspect();
    if (checked?.Id !== created.Id) throw Error('CAPABILITY_CONTAINER_CHANGED');
    // On-demand lifecycle starts it when used; installing does not open a session.
  }
}
