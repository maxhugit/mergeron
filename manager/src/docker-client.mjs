import http from 'node:http';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class DockerClient {
  constructor(
    socketPath = '/var/run/docker.sock',
    requestFactory = http.request,
  ) {
    this.socketPath = socketPath;
    this.requestFactory = requestFactory;
  }

  request(
    path,
    {
      method = 'GET',
      body,
      responseType = 'json',
      timeout = 5_000,
      maxResponseBytes = MAX_RESPONSE_BYTES,
    } = {},
  ) {
    const serializedBody =
      body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = this.requestFactory(
        {
          method,
          path,
          socketPath: this.socketPath,
          headers: {
            Accept: 'application/json',
            ...(serializedBody === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(serializedBody),
                }),
          },
          timeout,
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
            if (body.length > maxResponseBytes) {
              request.destroy(new Error('Docker response is too large'));
            }
          });
          response.on('end', () => {
            if (!response.statusCode || response.statusCode >= 300) {
              let message = '';
              try {
                const detail = JSON.parse(body);
                if (typeof detail.message === 'string')
                  message = `: ${detail.message.slice(0, 1024)}`;
              } catch {
                /* Keep non-JSON responses out of logs. */
              }
              reject(
                Object.assign(
                  new Error(
                    `Docker API returned HTTP ${response.statusCode ?? 'unknown'}${message}`,
                  ),
                  { statusCode: response.statusCode },
                ),
              );
              return;
            }
            try {
              if (responseType === 'json-sequence') {
                const messages = body
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => JSON.parse(line));
                const failure = messages.find((message) => message.error);
                if (failure) {
                  reject(
                    new Error(`Docker image pull failed: ${failure.error}`),
                  );
                  return;
                }
                resolve(messages);
                return;
              }
              resolve(body ? JSON.parse(body) : null);
            } catch {
              reject(new Error('Docker API returned invalid JSON'));
            }
          });
        },
      );
      request.on('timeout', () =>
        request.destroy(new Error('Docker API timeout')),
      );
      request.on('error', reject);
      request.end(serializedBody);
    });
  }

  listContainers() {
    return this.request('/containers/json?all=1');
  }

  inspectContainer(id) {
    return this.request(`/containers/${encodeURIComponent(id)}/json`);
  }

  listNetworks() {
    return this.request('/networks');
  }

  listImages() {
    return this.request('/images/json?all=0');
  }

  pullImage(reference) {
    const withoutDigest = reference.split('@');
    let fromImage = reference;
    let tag;
    if (withoutDigest.length === 1) {
      const slash = reference.lastIndexOf('/');
      const colon = reference.lastIndexOf(':');
      if (colon > slash) {
        fromImage = reference.slice(0, colon);
        tag = reference.slice(colon + 1);
      }
    }
    const query = new URLSearchParams({ fromImage });
    if (tag) query.set('tag', tag);
    return this.request(`/images/create?${query}`, {
      method: 'POST',
      responseType: 'json-sequence',
      timeout: 300_000,
      maxResponseBytes: 32 * 1024 * 1024,
    });
  }

  inspectNetwork(id) {
    return this.request(`/networks/${encodeURIComponent(id)}`);
  }

  createNetwork(specification) {
    return this.request('/networks/create', {
      method: 'POST',
      body: specification,
    });
  }

  createContainer(name, specification) {
    return this.request(`/containers/create?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body: specification,
    });
  }

  startContainer(id) {
    return this.request(`/containers/${encodeURIComponent(id)}/start`, {
      method: 'POST',
    });
  }

  stopContainer(id, graceSeconds = 60) {
    if (
      !Number.isInteger(graceSeconds) ||
      graceSeconds < 1 ||
      graceSeconds > 60
    )
      throw new Error('Invalid container stop grace period');
    return this.request(
      `/containers/${encodeURIComponent(id)}/stop?t=${graceSeconds}`,
      {
        method: 'POST',
        timeout: (graceSeconds + 10) * 1000,
      },
    );
  }

  renameContainer(id, name) {
    return this.request(
      `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`,
      { method: 'POST' },
    );
  }

  removeContainer(id) {
    // Never force a running container or remove its persistent volumes.
    return this.request(
      `/containers/${encodeURIComponent(id)}?force=false&v=false`,
      { method: 'DELETE' },
    );
  }

  inspectImage(reference) {
    return this.request(`/images/${encodeURIComponent(reference)}/json`);
  }

  waitContainer(id) {
    return this.request(
      `/containers/${encodeURIComponent(id)}/wait?condition=not-running`,
      {
        method: 'POST',
        timeout: 45000,
      },
    );
  }

  putArchive(id, archive, destination = '/workspace') {
    if (!['/workspace', '/control'].includes(destination))
      throw new Error('Invalid archive destination');
    if (!Buffer.isBuffer(archive) || archive.length > 64 * 1024 ** 2)
      throw new Error('PREVIEW_SOURCE_LIMIT');
    return new Promise((resolve, reject) => {
      const req = this.requestFactory(
        {
          socketPath: this.socketPath,
          path: `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(destination)}&noOverwriteDirNonDir=true`,
          method: 'PUT',
          timeout: 120000,
          headers: {
            'Content-Type': 'application/x-tar',
            'Content-Length': archive.length,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () =>
            res.statusCode === 200
              ? resolve(null)
              : reject(new Error('PREVIEW_SOURCE_UPLOAD_FAILED')),
          );
        },
      );
      req.on('timeout', () =>
        req.destroy(new Error('PREVIEW_SOURCE_UPLOAD_TIMEOUT')),
      );
      req.on('error', reject);
      req.end(archive);
    });
  }
  containerLogs(id) {
    return new Promise((resolve, reject) => {
      const req = this.requestFactory(
        {
          socketPath: this.socketPath,
          path: `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=100`,
          method: 'GET',
          timeout: 10000,
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 128 * 1024) req.destroy(new Error('PREVIEW_LOG_LIMIT'));
            else chunks.push(chunk);
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error('PREVIEW_LOG_UNAVAILABLE'));
              return;
            }
            const data = Buffer.concat(chunks);
            let offset = 0,
              text = '';
            while (offset + 8 <= data.length) {
              const length = data.readUInt32BE(offset + 4);
              if (length > 128 * 1024 || offset + 8 + length > data.length)
                break;
              text += data
                .subarray(offset + 8, offset + 8 + length)
                .toString('utf8');
              offset += 8 + length;
            }
            resolve(text);
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('PREVIEW_LOG_TIMEOUT')));
      req.on('error', reject);
      req.end();
    });
  }

  inspectDistribution(reference) {
    return this.request(`/distribution/${encodeURIComponent(reference)}/json`, {
      timeout: 20_000,
    });
  }
}
