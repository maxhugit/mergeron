import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface AuthConfiguration {
  version: 1;
  local: {
    enabled: boolean;
    sessionTtlHours: number;
    maxFailedAttempts: number;
    lockoutMinutes: number;
  };
  oidc: {
    enabled: boolean;
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string;
    autoRedirect: boolean;
  };
}

export type PublicAuthConfiguration = Omit<AuthConfiguration, 'oidc'> & {
  oidc: Omit<AuthConfiguration['oidc'], 'clientSecret'> & {
    clientSecretConfigured: boolean;
  };
};

const DEFAULT_CONFIGURATION: AuthConfiguration = {
  version: 1,
  local: {
    enabled: true,
    sessionTtlHours: 24,
    maxFailedAttempts: 5,
    lockoutMinutes: 15,
  },
  oidc: {
    enabled: false,
    issuerUrl: '',
    clientId: '',
    clientSecret: '',
    redirectUri: '',
    scopes: 'openid profile email',
    autoRedirect: false,
  },
};

@Injectable()
export class AuthConfigService {
  private readonly logger = new Logger(AuthConfigService.name);
  readonly path: string;
  private value: AuthConfiguration;

  constructor(config: ConfigService) {
    const codexHome =
      config.get<string>('CODEX_HOME') ?? join(homedir(), '.codex');
    this.path =
      config.get<string>('WEBUI_AUTH_CONFIG_PATH') ??
      join(codexHome, 'webui-auth.json');
    this.value = this.read();
  }

  get(): AuthConfiguration {
    return structuredClone(this.value);
  }

  getPublic(): PublicAuthConfiguration {
    const value = this.get();
    const { clientSecret, ...oidc } = value.oidc;
    return {
      ...value,
      oidc: { ...oidc, clientSecretConfigured: Boolean(clientSecret) },
    };
  }

  update(input: unknown): PublicAuthConfiguration {
    return this.save(this.prepareUpdate(input));
  }

  prepareUpdate(input: unknown): AuthConfiguration {
    return this.parse(input, this.value);
  }

  save(next: AuthConfiguration): PublicAuthConfiguration {
    this.persist(next);
    this.value = next;
    return this.getPublic();
  }

  private read(): AuthConfiguration {
    if (!existsSync(this.path)) {
      return structuredClone(DEFAULT_CONFIGURATION);
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      const value = this.parse(parsed, DEFAULT_CONFIGURATION);
      chmodSync(this.path, 0o600);
      return value;
    } catch (error) {
      this.logger.error(
        `Unable to read authentication configuration at ${this.path}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new Error('Invalid persisted authentication configuration');
    }
  }

  private persist(value: AuthConfiguration): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.path);
    chmodSync(this.path, 0o600);
  }

  private parse(input: unknown, current: AuthConfiguration): AuthConfiguration {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Invalid authentication configuration');
    const source = input as Record<string, unknown>;
    const local = this.object(source.local, 'local');
    const oidc = this.object(source.oidc, 'oidc');
    const number = (
      value: unknown,
      fallback: number,
      minimum: number,
      maximum: number,
      label: string,
    ) => {
      const resolved = value ?? fallback;
      if (
        typeof resolved !== 'number' ||
        !Number.isInteger(resolved) ||
        resolved < minimum ||
        resolved > maximum
      )
        throw new BadRequestException(`Invalid ${label}`);
      return resolved;
    };
    const boolean = (value: unknown, fallback: boolean, label: string) => {
      const resolved = value ?? fallback;
      if (typeof resolved !== 'boolean')
        throw new BadRequestException(`Invalid ${label}`);
      return resolved;
    };
    const string = (value: unknown, fallback: string, label: string) => {
      const resolved = value ?? fallback;
      if (typeof resolved !== 'string' || resolved.length > 2048)
        throw new BadRequestException(`Invalid ${label}`);
      return resolved.trim();
    };
    const secretInput = oidc.clientSecret;
    const secret =
      secretInput === undefined || secretInput === ''
        ? current.oidc.clientSecret
        : string(secretInput, '', 'OIDC client secret');
    const next: AuthConfiguration = {
      version: 1,
      local: {
        enabled: boolean(local.enabled, current.local.enabled, 'local state'),
        sessionTtlHours: number(
          local.sessionTtlHours,
          current.local.sessionTtlHours,
          1,
          24 * 30,
          'session lifetime',
        ),
        maxFailedAttempts: number(
          local.maxFailedAttempts,
          current.local.maxFailedAttempts,
          3,
          20,
          'failed-attempt limit',
        ),
        lockoutMinutes: number(
          local.lockoutMinutes,
          current.local.lockoutMinutes,
          1,
          24 * 60,
          'lockout duration',
        ),
      },
      oidc: {
        enabled: boolean(oidc.enabled, current.oidc.enabled, 'OIDC state'),
        issuerUrl: string(
          oidc.issuerUrl,
          current.oidc.issuerUrl,
          'OIDC issuer',
        ),
        clientId: string(
          oidc.clientId,
          current.oidc.clientId,
          'OIDC client ID',
        ),
        clientSecret: secret,
        redirectUri: string(
          oidc.redirectUri,
          current.oidc.redirectUri,
          'OIDC redirect URI',
        ),
        scopes: string(oidc.scopes, current.oidc.scopes, 'OIDC scopes'),
        autoRedirect: boolean(
          oidc.autoRedirect,
          current.oidc.autoRedirect,
          'OIDC automatic redirect',
        ),
      },
    };
    if (next.oidc.enabled) this.validateOidc(next.oidc);
    return next;
  }

  private validateOidc(oidc: AuthConfiguration['oidc']): void {
    if (!oidc.issuerUrl || !oidc.clientId || !oidc.clientSecret)
      throw new BadRequestException(
        'OIDC issuer, client ID and client secret are required',
      );
    if (!oidc.redirectUri)
      throw new BadRequestException('OIDC redirect URI is required');
    for (const [label, value] of [
      ['issuer', oidc.issuerUrl],
      ['redirect URI', oidc.redirectUri],
    ] as const) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new BadRequestException(`Invalid OIDC ${label}`);
      }
      if (
        url.protocol !== 'https:' &&
        !(process.env.NODE_ENV !== 'production' && url.hostname === 'localhost')
      )
        throw new BadRequestException(`OIDC ${label} must use HTTPS`);
      if (url.username || url.password || url.hash)
        throw new BadRequestException(`Invalid OIDC ${label}`);
    }
    if (!oidc.scopes.split(/\s+/).includes('openid'))
      throw new BadRequestException('OIDC scopes must include openid');
  }

  private object(value: unknown, label: string): Record<string, unknown> {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BadRequestException(`Invalid ${label} configuration`);
    return value as Record<string, unknown>;
  }
}
