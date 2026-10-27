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
      const request = http.request(
        {
          method,
          path,
          socketPath: this.socketPath(),
          timeout:
            path === '/v1/backups/delete'
              ? 120_000
              : path === '/v1/backups'
                ? 30_000
                : 3_000,
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
              request.destroy(new Error('Manager response is too large'));
          });
          response.on('end', () => {
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
            } catch (error) {
              reject(
                error instanceof Error
                  ? error
                  : new Error('Invalid Manager response'),
              );
            }
          });
        },
      );
      request.on('timeout', () =>
        request.destroy(new Error('Mergeron Manager timeout')),
      );
      request.on('error', reject);
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
    },
  ) {
    const path = action === 'apply' ? '/v1/update' : `/v1/update/${action}`;
    return this.requestManager(path, 'POST', {
      images: input?.images,
      confirmation: input?.confirmation,
      expectedFingerprint: input?.expectedFingerprint,
      operationId: input?.operationId,
      ...(input?.mode !== undefined ? { mode: input.mode } : {}),
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
