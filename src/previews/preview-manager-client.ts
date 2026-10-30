import { Injectable, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import http from 'node:http';

@Injectable()
export class PreviewManagerClient {
  constructor(private readonly config: ConfigService) {}
  request(
    operation: string,
    input: Record<string, unknown> = {},
    deadlineMs?: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(input);
      const req = http.request(
        {
          socketPath:
            this.config.get<string>('MERGERON_MANAGER_SOCKET') ??
            '/run/mergeron-manager/manager.sock',
          path: '/v1/previews/' + operation,
          method: 'POST',
          timeout: ['start', 'sync', 'stop', 'delete'].includes(operation)
            ? 180000
            : 15000,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            raw += chunk;
            if (Buffer.byteLength(raw) > 128 * 1024)
              req.destroy(new Error('PREVIEW_RESPONSE_LIMIT'));
          });
          res.on('end', () => {
            try {
              const value = JSON.parse(raw) as Record<string, unknown>;
              if (!value || typeof value !== 'object' || Array.isArray(value))
                throw Error();
              if (res.statusCode !== 200)
                reject(
                  new HttpException(
                    typeof value.error === 'string'
                      ? value.error
                      : 'PREVIEW_MANAGER_UNAVAILABLE',
                    409,
                  ),
                );
              else resolve(value);
            } catch {
              reject(new Error('PREVIEW_MANAGER_UNAVAILABLE'));
            }
          });
        },
      );
      req.on('timeout', () =>
        req.destroy(new Error('PREVIEW_MANAGER_TIMEOUT')),
      );
      req.on('error', reject);
      // Discovery runs before every agent turn: a stalled Unix connection must
      // not hold an unrelated conversation for the normal operation timeout.
      if (deadlineMs !== undefined) {
        const deadline = setTimeout(
          () => req.destroy(new Error('PREVIEW_MANAGER_TIMEOUT')),
          deadlineMs,
        );
        deadline.unref();
        req.once('close', () => clearTimeout(deadline));
      }
      req.end(body);
    });
  }
}
