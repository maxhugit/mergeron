import { readFileSync } from 'node:fs';

export const BYPARR_IMAGE =
  'ghcr.io/thephaseless/byparr@sha256:874f719518f617d03a60e03411fc5d090647e1a877041e81f8dc965927c7deb6';
const source = readFileSync(new URL('./fetch.py', import.meta.url), 'utf8');

/** Optional, removable adapter. No host mounts, published port or credential env. */
export class AppCatalogRunner {
  busy = false;
  constructor({ docker, manifest, enabled = false }) {
    this.docker = docker;
    this.manifest = manifest;
    this.enabled = enabled;
  }
  async status() {
    const base = {
      enabled: this.enabled,
      present: false,
      running: false,
      healthy: false,
      version: null,
      error: null,
    };
    try {
      const current = await this.docker.inspectContainer(
        this.manifest.stack + '-byparr',
      );
      const labels = current.Config?.Labels ?? {};
      if (
        labels['io.mergeron.stack'] !== this.manifest.stack ||
        labels['io.mergeron.component'] !== 'appCatalog' ||
        labels['io.mergeron.managed'] !== 'true'
      )
        return { ...base, error: 'CATALOG_OWNERSHIP' };
      const image = await this.docker.inspectImage(current.Image);
      const version = image.Config?.Env?.find((value) =>
        value.startsWith('VERSION='),
      )?.slice(8);
      return {
        ...base,
        present: true,
        running: current.State?.Running === true,
        healthy: current.State?.Health?.Status === 'healthy',
        version: /^v?\d+\.\d+\.\d+$/.test(version ?? '')
          ? version.replace(/^v/, '')
          : null,
      };
    } catch (error) {
      return error.statusCode === 404
        ? base
        : { ...base, error: 'CATALOG_WORKER_UNAVAILABLE' };
    }
  }
  async prepare() {
    if (!this.enabled) throw Error('CATALOG_DISABLED');
    if (this.busy) throw Error('CATALOG_BUSY');
    this.busy = true;
    try {
      try {
        await this.docker.inspectImage(BYPARR_IMAGE);
      } catch {
        await this.docker.pullImage(BYPARR_IMAGE);
      }
      await this.ensure(true);
      return { ready: true };
    } finally {
      this.busy = false;
    }
  }
  async ensure(replaceReviewedImage = false) {
    const name = this.manifest.stack + '-byparr';
    const network = this.manifest.networks.find((n) => n.id === 'isolated');
    if (!network?.internal) throw Error('CATALOG_NETWORK');
    let current;
    try {
      current = await this.docker.inspectContainer(name);
    } catch (error) {
      if (error.statusCode !== 404) throw Error('CATALOG_WORKER_UNAVAILABLE');
    }
    if (current) {
      const labels = current.Config?.Labels ?? {};
      if (
        labels['io.mergeron.managed'] !== 'true' ||
        labels['io.mergeron.stack'] !== this.manifest.stack ||
        labels['io.mergeron.component'] !== 'appCatalog' ||
        current.Config?.User !== '1000:1000' ||
        current.HostConfig?.Privileged ||
        current.Mounts?.some((m) => m.Type === 'bind') ||
        current.HostConfig?.NetworkMode !== network.name ||
        Object.keys(current.HostConfig?.PortBindings ?? {}).length
      )
        throw Error('CATALOG_OWNERSHIP');
      const image = await this.docker.inspectImage(BYPARR_IMAGE);
      if (current.Image !== image.Id) {
        if (!replaceReviewedImage) throw Error('CATALOG_IMAGE_CHANGED');
        if (current.State?.Running)
          await this.docker.stopContainer(current.Id, 1);
        await this.docker.removeContainer(current.Id);
      } else {
        if (!current.State?.Running)
          await this.docker.startContainer(current.Id);
        return current.Id;
      }
    }
    await this.docker.inspectImage(BYPARR_IMAGE);
    const created = await this.docker.createContainer(name, {
      Image: BYPARR_IMAGE,
      Entrypoint: ['/app/.venv/bin/python', '-u', '-c'],
      Cmd: [
        'import os,runpy; import src.utils as u; original=u.InvisiblePlaywright; u.InvisiblePlaywright=lambda *a,**kw: original(*a,**dict(kw,timezone=os.environ.get("TZ","UTC"))); runpy.run_path("/app/main.py",run_name="__main__")',
      ],
      Healthcheck: {
        Test: [
          'CMD',
          '/app/.venv/bin/python',
          '-c',
          'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8191/docs",timeout=3)',
        ],
        Interval: 30000000000,
        Timeout: 5000000000,
        Retries: 3,
        StartPeriod: 10000000000,
      },
      User: '1000:1000',
      WorkingDir: '/app',
      Labels: {
        'io.mergeron.managed': 'true',
        'io.mergeron.component': 'appCatalog',
        'io.mergeron.stack': this.manifest.stack,
      },
      Env: [
        'HOME=/home/byparr',
        'XDG_CACHE_HOME=/cache',
        'HOST=127.0.0.1',
        'TZ=Europe/Paris',
        'BROWSER_LOCALE=fr-FR',
        'PROXY_SERVER=http://' + this.manifest.stack + '-squid:3128',
      ],
      NetworkingConfig: { EndpointsConfig: { [network.name]: {} } },
      HostConfig: {
        NetworkMode: network.name,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: 2 * 1024 ** 3,
        NanoCpus: 1500000000,
        PidsLimit: 512,
        ShmSize: 512 * 1024 ** 2,
        Tmpfs: { '/tmp': 'rw,exec,nosuid,nodev,size=512m,mode=1777' },
        RestartPolicy: { Name: 'unless-stopped' },
        LogConfig: {
          Type: 'json-file',
          Config: { 'max-size': '2m', 'max-file': '2' },
        },
        Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
      },
    });
    await this.docker.startContainer(created.Id);
    return created.Id;
  }
  async download(input) {
    if (!this.enabled) throw Error('CATALOG_DISABLED');
    if (this.busy) throw Error('CATALOG_BUSY');
    if (
      !input ||
      Object.keys(input).some(
        (k) => !['accessToken', 'accountId'].includes(k),
      ) ||
      !['accessToken', 'accountId'].every(
        (k) =>
          typeof input[k] === 'string' &&
          input[k].length > 0 &&
          input[k].length < 12000,
      )
    )
      throw Error('CATALOG_AUTH');
    this.busy = true;
    let id;
    try {
      id = await this.ensure();
      const result = await this.docker.catalogJob(id, source, input);
      if (!Array.isArray(result.apps) || result.error)
        throw Error('CATALOG_DOWNLOAD_FAILED');
      return result;
    } catch (error) {
      if (/^CATALOG_[A-Z_]+$/.test(error.message ?? '')) throw error;
      throw Error('CATALOG_WORKER_UNAVAILABLE');
    } finally {
      try {
        // Keep the managed container, but reliably clear the entire browser tree.
        if (id) {
          await this.docker.stopContainer(id, 1);
          await this.docker.startContainer(id);
        }
      } catch {
        throw Error('CATALOG_CLEANUP_FAILED');
      } finally {
        this.busy = false;
      }
    }
  }
}
