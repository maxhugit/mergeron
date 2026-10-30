import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import {
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  lstatSync,
  constants,
} from 'node:fs';
import { Agent, request } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { lookup } from 'node:dns';
import { BlockList, isIPv4 } from 'node:net';
import webpush from 'web-push';
import { validatePushEndpoint } from './push-validation';

const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  denied.addSubnet(address, prefix);
export const publicPushAddress = (address: string) =>
  isIPv4(address) && !denied.check(address);

@Injectable()
export class PushTransportService implements OnModuleInit {
  private readonly logger = new Logger(PushTransportService.name);
  private keys: { publicKey: string; privateKey: string } | null = null;
  private subject = '';
  private directAgent() {
    return new Agent({
      keepAlive: false,
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true, family: 4 }, (error, addresses) => {
          if (
            error ||
            !addresses.length ||
            addresses.some((item) => !publicPushAddress(item.address))
          )
            return callback(
              error ?? new Error('pushDestinationBlocked'),
              '',
              4,
            );
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, 4);
        });
      },
    });
  }
  constructor(
    private readonly config: ConfigService,
    private readonly database: DatabaseService,
  ) {}

  onModuleInit() {
    try {
      const value =
        this.config.get<string>('WEBUI_PUSH_SUBJECT') ||
        this.config.get<string>('MERGERON_PUBLIC_URL');
      const subject = new URL(value ?? '');
      if (
        !['https:', 'mailto:'].includes(subject.protocol) ||
        subject.username ||
        subject.password ||
        (subject.protocol === 'mailto:' &&
          !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(subject.pathname)) ||
        (subject.protocol === 'https:' &&
          (!subject.hostname.includes('.') ||
            subject.hostname.endsWith('.localhost')))
      )
        throw Error();
      this.subject = subject.href;
      const path = `${this.database.databasePath}.push-vapid.json`;
      try {
        const fd = openSync(path, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify(webpush.generateVAPIDKeys()));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
        throw Error();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        this.keys = JSON.parse(readFileSync(fd, 'utf8')) as typeof this.keys;
      } finally {
        closeSync(fd);
      }
      // Validate persisted keys once; never silently rotate corrupt keys.
      webpush.getVapidHeaders(
        'https://fcm.googleapis.com',
        this.subject,
        this.keys!.publicKey,
        this.keys!.privateKey,
        'aes128gcm',
      );
    } catch {
      this.keys = null;
      this.logger.warn(
        'Web Push unavailable: verify public URL and the private VAPID key file.',
      );
    }
  }
  publicKey() {
    return this.keys?.publicKey ?? null;
  }
  async send(
    subscription: { endpoint: string; p256dh: string; auth: string },
    payload: object,
    ttl: number,
    topic: string,
  ) {
    if (!this.keys) throw new Error('pushNotConfigured');
    validatePushEndpoint(subscription.endpoint);
    // The deployment proxy retains its private-address deny rules. Only the
    // fixed browser push domains are added to its allowlist.
    const proxy =
      this.config.get<string>('HTTPS_PROXY') ||
      this.config.get<string>('https_proxy');
    const details = webpush.generateRequestDetails(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      {
        vapidDetails: { subject: this.subject, ...this.keys },
        TTL: Math.max(0, Math.min(3600, ttl)),
        urgency: 'normal',
        topic,
        contentEncoding: 'aes128gcm',
      },
    );
    const agent = proxy ? new HttpsProxyAgent(proxy) : this.directAgent();
    // Bound DNS, proxy negotiation and the complete response, not just socket
    // inactivity. Never retain provider bodies or follow redirects.
    try {
      await new Promise<void>((resolve, reject) => {
        const outgoing = request(
          details.endpoint,
          {
            method: details.method,
            headers: details.headers,
            agent,
            signal: AbortSignal.timeout(12_000),
          },
          (response) => {
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 8192)
                outgoing.destroy(new Error('pushResponseTooLarge'));
            });
            response.on('error', reject);
            response.on('end', () => {
              const statusCode = response.statusCode ?? 0;
              if (statusCode >= 200 && statusCode < 300) resolve();
              else
                reject(
                  Object.assign(new Error('pushProviderRejected'), {
                    statusCode,
                  }),
                );
            });
          },
        );
        outgoing.on('error', reject);
        outgoing.end(details.body);
      });
    } finally {
      agent.destroy();
    }
  }
}
