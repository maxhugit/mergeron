/** Unit tests for ApiKeyGuard query-token whitelist and bearer extraction. */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessException } from '../common/business.exception';
import { ApiKeyGuard } from './api-key.guard';
import { AuthService } from './auth.service';
import { LocalAuthService } from './local-auth.service';

function mockRequest(
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
) {
  return { url, method, headers, query } as unknown;
}

function mockContext(request: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let authService: Partial<AuthService>;

  beforeEach(() => {
    authService = {
      authenticateToken: vi.fn().mockResolvedValue({ ok: true }),
      verifyJwt: vi.fn().mockResolvedValue(true),
    };
    const reflector = {
      getAllAndOverride: () => false,
    } as unknown as Reflector;
    guard = new ApiKeyGuard(authService as AuthService, reflector);
  });

  describe('query access_token whitelist', () => {
    const validJwt = 'header.payload.signature';

    it('accepts access_token on /api/files/serve', async () => {
      const req = mockRequest(
        '/api/files/serve?path=test.png&access_token=' + validJwt,
        'GET',
        {},
        { access_token: validJwt, path: 'test.png' },
      );
      await expect(guard.canActivate(mockContext(req))).resolves.toBe(true);
      expect(authService.verifyJwt).toHaveBeenCalledWith(validJwt);
    });

    it('accepts access_token on /api/files/archive/entry', async () => {
      const req = mockRequest(
        '/api/files/archive/entry?path=a.zip&entry=f.txt&access_token=' +
          validJwt,
        'GET',
        {},
        { access_token: validJwt, path: 'a.zip', entry: 'f.txt' },
      );
      await expect(guard.canActivate(mockContext(req))).resolves.toBe(true);
      expect(authService.verifyJwt).toHaveBeenCalledWith(validJwt);
    });

    it('rejects access_token on non-whitelisted endpoints', async () => {
      const req = mockRequest(
        '/api/threads?access_token=' + validJwt,
        'GET',
        {},
        { access_token: validJwt },
      );
      await expect(guard.canActivate(mockContext(req))).rejects.toThrow(
        BusinessException,
      );
    });

    it('rejects access_token on POST requests', async () => {
      const req = mockRequest(
        '/api/files/serve?access_token=' + validJwt,
        'POST',
        {},
        { access_token: validJwt },
      );
      await expect(guard.canActivate(mockContext(req))).rejects.toThrow(
        BusinessException,
      );
    });

    it('rejects non-JWT query tokens', async () => {
      const rawKey = 'not-a-jwt';
      const req = mockRequest(
        '/api/files/serve?access_token=' + rawKey,
        'GET',
        {},
        { access_token: rawKey },
      );
      await expect(guard.canActivate(mockContext(req))).rejects.toThrow(
        BusinessException,
      );
    });
  });

  describe('bearer header', () => {
    it('rejects preview-origin mutations through trusted SSO without weakening ordinary bearer clients', async () => {
      vi.stubEnv('MERGERON_PREVIEWS_ENABLED', 'true');
      vi.stubEnv('MERGERON_PUBLIC_URL', 'https://mergeron.example.test');
      try {
        for (const origin of [
          'https://id.preview.example.test',
          'http://mergeron.example.test',
        ]) {
          await expect(
            guard.canActivate(
              mockContext(
                mockRequest('/api/threads', 'POST', {
                  host: 'mergeron.example.test',
                  origin,
                  'x-webui-auth-source': 'authentik',
                  authorization: 'Bearer valid-token',
                }),
              ),
            ),
          ).rejects.toThrow(BusinessException);
        }
        await expect(
          guard.canActivate(
            mockContext(
              mockRequest('/api/threads', 'POST', {
                host: 'mergeron.example.test',
                origin: 'https://mergeron.example.test',
                'x-webui-auth-source': 'authentik',
                authorization: 'Bearer valid-token',
              }),
            ),
          ),
        ).resolves.toBe(true);
        await expect(
          guard.canActivate(
            mockContext(
              mockRequest('/api/threads', 'POST', {
                authorization: 'Bearer valid-token',
              }),
            ),
          ),
        ).resolves.toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it('authenticates valid bearer token', async () => {
      const req = mockRequest('/api/threads', 'GET', {
        authorization: 'Bearer valid-token',
      });
      await expect(guard.canActivate(mockContext(req))).resolves.toBe(true);
      expect(authService.authenticateToken).toHaveBeenCalledWith(
        'valid-token',
        undefined,
      );
    });

    it('rejects missing authorization', async () => {
      const req = mockRequest('/api/threads', 'GET');
      await expect(guard.canActivate(mockContext(req))).rejects.toThrow(
        BusinessException,
      );
    });
  });

  describe('local session cookie', () => {
    it('drops a cached socket person when their local session has been revoked', async () => {
      const localAuth = {
        authenticateCookie: vi.fn().mockReturnValue(null),
      } as unknown as LocalAuthService;
      const reflector = {
        getAllAndOverride: () => false,
      } as unknown as Reflector;
      const checked = new ApiKeyGuard(
        authService as AuthService,
        reflector,
        localAuth,
      );
      const socket = {
        id: 's1',
        data: { authenticatedPersonId: 'old-admin' } as Record<string, unknown>,
        handshake: {
          headers: {
            cookie: 'codex_webui_session=revoked',
            authorization: 'Bearer valid-token',
          },
          auth: {},
        },
      };
      const context = {
        getType: () => 'ws',
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToWs: () => ({ getClient: () => socket }),
      } as unknown as ExecutionContext;
      expect(await checked.canActivate(context)).toBe(true);
      expect(socket.data.authenticatedPersonId).toBeUndefined();
    });
    it('accepts safe requests authenticated by a local session', async () => {
      const localAuth = {
        authenticateCookie: vi.fn().mockReturnValue('person-1'),
      } as unknown as LocalAuthService;
      const reflector = {
        getAllAndOverride: () => false,
      } as unknown as Reflector;
      guard = new ApiKeyGuard(authService as AuthService, reflector, localAuth);
      const request = mockRequest('/api/threads', 'GET', {
        cookie: 'codex_webui_session=opaque',
      }) as { authenticatedPersonId?: string };

      await expect(guard.canActivate(mockContext(request))).resolves.toBe(true);
      expect(request.authenticatedPersonId).toBe('person-1');
    });

    it('rejects cross-origin writes made with a local session cookie', async () => {
      const localAuth = {
        authenticateCookie: vi.fn().mockReturnValue('person-1'),
      } as unknown as LocalAuthService;
      const reflector = {
        getAllAndOverride: () => false,
      } as unknown as Reflector;
      guard = new ApiKeyGuard(authService as AuthService, reflector, localAuth);
      const request = mockRequest('/api/settings', 'PATCH', {
        cookie: 'codex_webui_session=opaque',
        origin: 'https://attacker.example',
        host: 'codex.example',
      });

      await expect(guard.canActivate(mockContext(request))).rejects.toThrow(
        'Cross-origin cookie request rejected',
      );
    });
  });
});
