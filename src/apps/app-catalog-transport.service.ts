import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import http from 'node:http';

/** Sole removable bridge to the optional Byparr adapter in the Manager. */
@Injectable()
export class AppCatalogTransport {
  constructor(private readonly config: ConfigService) {}
  request(
    operation: 'prepare' | 'download' | 'status',
    input: Record<string, string> = {},
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(input);
      const req = http.request(
        {
          socketPath:
            this.config.get<string>('MERGERON_MANAGER_SOCKET') ??
            '/run/mergeron-manager/manager.sock',
          path: '/v1/app-catalog/' + operation,
          method: operation === 'status' ? 'GET' : 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length':
              operation === 'status' ? 0 : Buffer.byteLength(body),
          },
        },
        (res) => {
          let raw = '',
            size = 0;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            size += Buffer.byteLength(chunk);
            if (size > 32 * 1024 ** 2)
              req.destroy(Error('CATALOG_RESPONSE_LIMIT'));
            else raw += chunk;
          });
          res.on('error', () => reject(Error('CATALOG_MANAGER_UNAVAILABLE')));
          res.on('end', () => {
            try {
              const value = JSON.parse(raw) as { error?: string };
              if (res.statusCode !== 200)
                return reject(
                  Error(
                    value?.error && /^CATALOG_[A-Z_]+$/.test(value.error)
                      ? value.error
                      : 'CATALOG_MANAGER_UNAVAILABLE',
                  ),
                );
              resolve(value);
            } catch {
              reject(Error('CATALOG_MANAGER_UNAVAILABLE'));
            }
          });
        },
      );
      const timer = setTimeout(
        () => req.destroy(Error('CATALOG_TIMEOUT')),
        operation === 'status'
          ? 3000
          : operation === 'prepare'
            ? 320000
            : 180000,
      );
      timer.unref();
      req.once('close', () => clearTimeout(timer));
      req.on('error', () => reject(Error('CATALOG_MANAGER_UNAVAILABLE')));
      req.end(operation === 'status' ? undefined : body);
    });
  }
}
