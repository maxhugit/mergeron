import { afterEach, expect, it, vi } from 'vitest';
import { saveLogRetentionRule } from './logs-api';

vi.mock('@/auth-token', () => ({ getAuthorizationHeader: () => null }));
afterEach(() => vi.unstubAllGlobals());
it('patches only the selected rule, without filenames or the other family', async () => {
  const rule = { enabled: true, maxAgeDays: 5, maxFiles: 5, maxFileMiB: 50 };
  const network = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ policy: { codex: rule } }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', network);
  await saveLogRetentionRule('codex', rule);
  expect(network).toHaveBeenCalledWith('/api/logs/retention/codex', {
    method: 'PATCH',
    body: JSON.stringify(rule),
    headers: { 'Content-Type': 'application/json' },
  });
});
it('reports a refused family update instead of treating it as saved', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('{}', { status: 403 })),
  );
  await expect(
    saveLogRetentionRule('application', {
      enabled: true,
      maxAgeDays: 5,
      maxFiles: 5,
    }),
  ).rejects.toThrow('HTTP 403');
});
