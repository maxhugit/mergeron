import { afterEach, expect, it, vi } from 'vitest';
import { platformCookie, platformCookiePath } from './platform-cookie';
afterEach(() => vi.unstubAllEnvs());
it('retains legacy sessions while previews are disabled', () => {
  vi.stubEnv('MERGERON_PREVIEWS_ENABLED', 'false');
  expect(platformCookie('codex_webui_session')).toBe('codex_webui_session');
  expect(platformCookiePath('/api/auth/oidc')).toBe('/api/auth/oidc');
});
it('uses browser-enforced host-only names and root paths with untrusted sibling previews', () => {
  vi.stubEnv('MERGERON_PREVIEWS_ENABLED', 'true');
  for (const name of [
    'codex_webui_session',
    'codex_webui_oidc_state',
    'mergeron_impersonation',
  ])
    expect(platformCookie(name)).toBe('__Host-' + name);
  expect(platformCookiePath('/api/auth/oidc')).toBe('/');
});
