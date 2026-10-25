import { ConfigService } from '@nestjs/config';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthConfigService } from './auth-config.service';

describe('AuthConfigService', () => {
  let directory: string;
  let path: string;
  let service: AuthConfigService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'webui-auth-config-'));
    path = join(directory, 'auth.json');
    const config = {
      get: (key: string) =>
        key === 'WEBUI_AUTH_CONFIG_PATH' ? path : undefined,
    } as ConfigService;
    service = new AuthConfigService(config);
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('defaults to username/password with OIDC and its redirect disabled', () => {
    expect(service.getPublic().local.enabled).toBe(true);
    expect(service.getPublic().oidc.enabled).toBe(false);
    expect(service.getPublic().oidc.autoRedirect).toBe(false);
  });

  it('preserves the explicit authentication choices of an existing installation', () => {
    const stored = {
      version: 1,
      local: { enabled: false },
      oidc: {
        enabled: true,
        issuerUrl: 'https://identity.example.test',
        clientId: 'existing',
        clientSecret: 'private',
        redirectUri: 'https://webui.example.test/api/auth/oidc/callback',
        autoRedirect: true,
      },
    };
    writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
    const existing = new AuthConfigService({
      get: (key: string) =>
        key === 'WEBUI_AUTH_CONFIG_PATH' ? path : undefined,
    } as ConfigService);
    expect(existing.get().local.enabled).toBe(false);
    expect(existing.get().oidc.enabled).toBe(true);
    expect(existing.get().oidc.autoRedirect).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(stored);
  });

  it('persists configuration atomically with owner-only permissions', () => {
    const result = service.update({
      local: { sessionTtlHours: 12 },
      oidc: {
        issuerUrl: 'https://sso.example.test/application/o/webui/',
        clientId: 'webui',
        clientSecret: 'private-value',
      },
    });

    expect(result.local.sessionTtlHours).toBe(12);
    expect(result.oidc.clientSecretConfigured).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as {
      oidc: { clientSecret: string };
    };
    expect(persisted.oidc.clientSecret).toBe('private-value');
  });

  it('requires a complete HTTPS OIDC configuration before activation', () => {
    expect(() => service.update({ oidc: { enabled: true } })).toThrow(
      'OIDC issuer, client ID and client secret are required',
    );
    const result = service.update({
      oidc: {
        enabled: true,
        issuerUrl: 'https://sso.example.test/application/o/webui/',
        clientId: 'webui',
        clientSecret: 'private-value',
        redirectUri: 'https://webui.example.test/api/auth/oidc/callback',
      },
    });
    expect(result.oidc.enabled).toBe(true);
    expect(result.oidc.clientSecretConfigured).toBe(true);
  });
});
