import { afterEach, expect, it, vi } from 'vitest';
import {
  clearSessionDiagnostics,
  exportSessionDiagnostics,
  getSessionDiagnostics,
  recordSessionDiagnostic,
  SESSION_DIAGNOSTIC_LIMIT,
  subscribeSessionDiagnostics,
} from './session-diagnostics';
import {
  acceptVerifiedSession,
  installSessionRecovery,
  isSessionPaused,
} from './session-recovery';
afterEach(() => {
  clearSessionDiagnostics();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('bounds memory and export size and coalesces repeated events', () => {
  for (let generation = 0; generation < 250; generation++)
    recordSessionDiagnostic('check_started', { generation });
  expect(getSessionDiagnostics()).toHaveLength(SESSION_DIAGNOSTIC_LIMIT);
  expect(getSessionDiagnostics()[0].generation).toBe(150);
  for (let n = 0; n < 1000; n++)
    recordSessionDiagnostic('request_blocked', { generation: 250 });
  expect(getSessionDiagnostics()).toHaveLength(SESSION_DIAGNOSTIC_LIMIT);
  expect(getSessionDiagnostics().at(-1)?.count).toBe(1000);
  expect(exportSessionDiagnostics().length).toBeLessThan(40000);
});
it('exports an allowlist only, without errors, URLs, identities, credentials or arbitrary fields', () => {
  const script = document.createElement('script');
  script.src =
    'https://private.test/confidential/index-Test1234.js?token=SECRET_TOKEN';
  document.head.append(script);
  recordSessionDiagnostic('check_failed', {
    reason: 'server_unavailable',
    status: 503,
    durationMs: 120,
    ...{
      token: 'SECRET_TOKEN',
      email: 'person@example.test',
      url: 'https://private.test/?token=SECRET_TOKEN',
      message: 'PRIVATE_MESSAGE',
      headers: { Cookie: 'PRIVATE_COOKIE' },
    },
  });
  recordSessionDiagnostic('check_failed', {
    reason: 'PRIVATE_REASON' as 'transport',
    status: 0,
    durationMs: Infinity,
  });
  const value = exportSessionDiagnostics();
  for (const privateValue of [
    'SECRET_TOKEN',
    'person@example.test',
    'private.test',
    'PRIVATE_MESSAGE',
    'PRIVATE_COOKIE',
    'PRIVATE_REASON',
  ])
    expect(value).not.toContain(privateValue);
  const data = JSON.parse(value);
  script.remove();
  expect(data.clientAsset).toBe('index-Test1234.js');
  expect(data.scope).toBe('this-tab-only');
  expect(data.events[0]).toMatchObject({ status: 503, durationMs: 120 });
  expect(data.events[1]).not.toHaveProperty('status');
  expect(data.events[1]).not.toHaveProperty('durationMs');
});
it('clearing or subscribing to evidence never changes permissions or sends a request', async () => {
  const network = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', network);
  const dispose = installSessionRecovery();
  const unsubscribe = subscribeSessionDiagnostics(() => {
    throw Error('untrusted subscriber');
  });
  try {
    expect(() => clearSessionDiagnostics()).not.toThrow();
    expect(isSessionPaused()).toBe(true);
    await expect(fetch('/api/projects', { method: 'POST' })).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
    acceptVerifiedSession({
      kind: 'person',
      active: true,
      personId: 'a',
      name: null,
      role: 'standard',
    });
    expect(isSessionPaused()).toBe(false);
    expect(getSessionDiagnostics().at(-1)?.event).toBe('resumed');
  } finally {
    unsubscribe();
    dispose();
  }
});
