import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { IdentityService } from './identity.service';
import type { AuthConfigService } from './auth-config.service';
import type { LocalAuthService } from './local-auth.service';
import {
  OidcAuthService,
  SilentOidcFailure,
  silentReturnPath,
} from './oidc-auth.service';

const id = 'a'.repeat(32);
function fixture(enabled = true) {
  const headers: Record<string, unknown> = {};
  const reply = {
    header: vi.fn((key: string, value: unknown) => {
      headers[key.toLowerCase()] = value;
      return reply;
    }),
    code: vi.fn(() => reply),
    type: vi.fn(() => reply),
    send: vi.fn(),
  };
  const oidc = {
    start: vi.fn(() =>
      Promise.resolve({
        cookie: 'state-cookie',
        authorizationUrl: 'https://sso.example.test/authorize?prompt=none',
      }),
    ),
    callback: vi.fn(),
    clearFlowCookie: () => 'cleared',
  };
  const controller = new AuthController(
    {
      validateApiKey: (value: unknown) => value === 'trusted-backend',
    } as unknown as AuthService,
    {} as IdentityService,
    { get: () => ({ oidc: { enabled } }) } as AuthConfigService,
    {} as LocalAuthService,
    oidc as unknown as OidcAuthService,
  );
  const request = (extra = {}) =>
    ({
      headers: { 'sec-fetch-site': 'same-origin', ...extra },
    }) as unknown as FastifyRequest;
  return {
    controller,
    reply,
    response: reply as unknown as FastifyReply,
    headers,
    oidc,
    request,
  };
}

it('uses native standard OIDC silent login with a fixed callback and no application data', async () => {
  const f = fixture();
  await f.controller.silentRenewal(id, f.request(), f.response);
  expect(f.oidc.start).toHaveBeenCalledWith(
    `${silentReturnPath}?request=${id}`,
    false,
    true,
  );
  expect(f.headers.location).toBe(
    'https://sso.example.test/authorize?prompt=none',
  );
  expect(f.headers['cache-control']).toBe('no-store');
});

it.each(['authentik', 'sso-proxy'])(
  'accepts a completed %s proxy flow only with its server credential',
  async (source) => {
    const f = fixture();
    await f.controller.silentRenewal(
      id,
      f.request({
        'x-webui-auth-source': source,
        authorization: 'Bearer trusted-backend',
        'sec-fetch-site': 'cross-site',
      }),
      f.response,
    );
    expect(f.oidc.start).not.toHaveBeenCalled();
    const html = f.reply.send.mock.calls[0][0] as string;
    expect(html).toContain('"status":"complete"');
    expect(html).not.toContain('trusted-backend');
    expect(f.headers['content-security-policy']).toContain(
      "frame-ancestors 'self'",
    );
    expect(f.headers['x-frame-options']).toBe('SAMEORIGIN');
  },
);

it('does not trust a browser-supplied proxy marker', async () => {
  const f = fixture();
  await f.controller.silentRenewal(
    id,
    f.request({
      'x-webui-auth-source': 'sso-proxy',
      authorization: 'Bearer forged',
    }),
    f.response,
  );
  expect(f.oidc.start).toHaveBeenCalled();
});

it('rejects cross-origin initiation before creating native authentication state', async () => {
  const f = fixture();
  await expect(
    f.controller.silentRenewal(
      id,
      f.request({ 'sec-fetch-site': 'cross-site' }),
      f.response,
    ),
  ).rejects.toThrow('Same-origin');
  expect(f.oidc.start).not.toHaveBeenCalled();
});

it('reports interactive local login without navigation or extending a session', async () => {
  const f = fixture(false);
  await f.controller.silentRenewal(id, f.request(), f.response);
  expect(f.oidc.start).not.toHaveBeenCalled();
  expect(f.reply.send.mock.calls[0][0]).toContain('"status":"interactive"');
});

it('rejects injected request identifiers before rendering HTML', () => {
  const f = fixture();
  expect(() =>
    f.controller.silentRenewalComplete('</script>', null, f.response),
  ).toThrow('Invalid renewal request');
  expect(f.reply.send).not.toHaveBeenCalled();
});

it('returns a validated OIDC failure to the minimal completion page, never to an external URL', async () => {
  const f = fixture();
  f.oidc.callback.mockRejectedValue(
    new SilentOidcFailure(`${silentReturnPath}?request=${id}`, true),
  );
  await f.controller.oidcCallback({}, f.request(), f.response);
  expect(f.headers.location).toBe(
    `${silentReturnPath}?request=${id}&outcome=interactive`,
  );
  expect(f.headers['set-cookie']).toBe('cleared');
});

it('does not accept an arbitrary completion hint as an identity or token', () => {
  const f = fixture();
  f.controller.silentRenewalComplete(id, 'unavailable', f.response);
  const html = f.reply.send.mock.calls[0][0] as string;
  expect(html).toContain('window.parent.postMessage');
  expect(html).toContain('window.location.origin');
  expect(html).toContain('"status":"unavailable"');
  expect(html).not.toContain('token');
  expect(f.headers['cache-control']).toBe('no-store');
});
