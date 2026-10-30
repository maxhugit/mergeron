/** Administrator-facing bridge to the local Mergeron Manager Unix socket. */
import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import http from 'node:http';

const MAX_RESPONSE_BYTES = 1024 * 1024;

@Injectable()
export class ManagerStatusService {
  constructor(private readonly config: ConfigService) {}

  private socketPath(): string {
    return (
      this.config.get<string>('MERGERON_MANAGER_SOCKET') ??
      '/run/mergeron-manager/manager.sock'
    );
  }

  protected requestManager(
    path = '/v1/status',
    method: 'GET' | 'POST' = 'GET',
    payload?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const body = payload ? JSON.stringify(payload) : undefined;
      // Planning and durable acceptance can exceed the short polling budget
      // while Docker or the persistent filesystem is busy. The actual update
      // remains asynchronous; never retry a write whose outcome is uncertain.
      const timeoutMs = path.startsWith('/v1/images/updates')
        ? 30_000
        : path === '/v1/codex-cli/install'
          ? 210_000
          : path === '/v1/backups/delete'
            ? 120_000
            : path === '/v1/backups' ||
                path === '/v1/update' ||
                path.startsWith('/v1/update/')
              ? 30_000
              : 3_000;
      const unavailable = () =>
        new HttpException('mergeronManagerUnavailable', 503);
      const invalidResponse = () =>
        new HttpException('mergeronManagerInvalidResponse', 502);
      const timeout = () => new HttpException('mergeronManagerTimeout', 504);
      const request = http.request(
        {
          method,
          path,
          socketPath: this.socketPath(),
          timeout: timeoutMs,
          headers: {
            Accept: 'application/json',
            ...(body
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(body),
                }
              : {}),
          },
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_RESPONSE_BYTES)
              request.destroy(invalidResponse());
          });
          response.on('aborted', () => request.destroy(invalidResponse()));
          response.on('error', () => request.destroy(invalidResponse()));
          response.on('end', () => {
            clearTimeout(deadline);
            try {
              const value: unknown = JSON.parse(body);
              if (!value || typeof value !== 'object' || Array.isArray(value))
                throw new Error('Invalid Manager response');
              if (response.statusCode !== 200) {
                const error = (value as { error?: unknown }).error;
                reject(
                  new HttpException(
                    typeof error === 'string'
                      ? error
                      : 'mergeronManagerRequestFailed',
                    response.statusCode ?? 502,
                  ),
                );
                return;
              }
              resolve(value as Record<string, unknown>);
            } catch {
              reject(invalidResponse());
            }
          });
        },
      );
      const expire = () => request.destroy(timeout());
      request.on('timeout', expire);
      request.on('error', (error: Error) => {
        clearTimeout(deadline);
        reject(error instanceof HttpException ? error : unavailable());
      });
      request.on('close', () => {
        clearTimeout(deadline);
        // A premature close must not leave the bridge promise unresolved.
        // A response already accepted/rejected above is not changed.
        reject(unavailable());
      });
      // Socket inactivity alone does not bound connection establishment or a
      // stalled stream. Keep a finite deadline for every local Manager request.
      const deadline = setTimeout(expire, timeoutMs);
      deadline.unref();
      if (body) request.write(body);
      request.end();
    });
  }

  async status() {
    try {
      return { available: true, ...(await this.requestManager()) };
    } catch {
      return {
        available: false,
        mode: 'observe',
        dockerConnected: false,
        components: [],
        dataSafety: {
          status: 'unknown',
          blockers: [],
          protectedMounts: [],
        },
        error: 'mergeronManagerUnavailable',
      };
    }
  }

  async backups() {
    return this.requestManager('/v1/backups');
  }

  codexCli() {
    return this.requestManager('/v1/codex-cli');
  }

  installCodexCli(releaseId: string, manifestSha256: string) {
    return this.requestManager('/v1/codex-cli/install', 'POST', {
      releaseId,
      manifestSha256,
    });
  }

  imageUpdates(refresh = false) {
    return this.requestManager(
      `/v1/images/updates${refresh ? '?refresh=true' : ''}`,
    );
  }

  backupRetention() {
    return this.requestManager('/v1/backups/retention');
  }
  setBackupRetention(input: { maxBackups?: unknown }) {
    return this.requestManager('/v1/backups/retention', 'POST', {
      maxBackups: input?.maxBackups,
    });
  }

  async deleteBackup(input: { operationId?: unknown; confirmation?: unknown }) {
    return this.requestManager('/v1/backups/delete', 'POST', {
      operationId: input?.operationId,
      confirmation: input?.confirmation,
    });
  }

  async adopt(input: {
    confirmation?: unknown;
    expectedFingerprint?: unknown;
  }) {
    return {
      available: true,
      ...(await this.requestManager('/v1/adoption', 'POST', {
        confirmation: input?.confirmation,
        expectedFingerprint: input?.expectedFingerprint,
      })),
    };
  }

  async installationPlan() {
    return {
      available: true,
      ...(await this.requestManager('/v1/install/plan')),
    };
  }

  async updateOperation(
    action: 'plan' | 'apply' | 'rollback' | 'recover',
    input: {
      images?: unknown;
      confirmation?: unknown;
      expectedFingerprint?: unknown;
      operationId?: unknown;
      mode?: unknown;
      backupMode?: unknown;
    },
  ) {
    const path = action === 'apply' ? '/v1/update' : `/v1/update/${action}`;
    return this.requestManager(path, 'POST', {
      images: input?.images,
      confirmation: input?.confirmation,
      expectedFingerprint: input?.expectedFingerprint,
      operationId: input?.operationId,
      ...(input?.mode !== undefined ? { mode: input.mode } : {}),
      ...(input?.backupMode !== undefined
        ? { backupMode: input.backupMode }
        : {}),
    });
  }

  async install(input: {
    confirmation?: unknown;
    expectedFingerprint?: unknown;
  }) {
    return {
      available: true,
      ...(await this.requestManager('/v1/install', 'POST', {
        confirmation: input?.confirmation,
        expectedFingerprint: input?.expectedFingerprint,
      })),
    };
  }
}
