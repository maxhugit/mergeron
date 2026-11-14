import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { GitHubReadScheduler } from './github-read-scheduler';

const repo = { owner: 'owner', repo: 'repo', token: 'private-token' };
const target =
  'https://productionresultssa4.blob.core.windows.net/actions-results/log.txt?sig=private-signature';
const jobId = 131796715224;
const redirect = (location = target) =>
  new Response(null, { status: 302, headers: { location } });
afterEach(() => vi.unstubAllGlobals());

it('downloads only the GitHub-provided link, strips credentials, redacts secrets and never caches logs', async () => {
  const body =
    'Error private-token ghp_abcdefghij\nAuthorization: Bearer another-value';
  const fetch = vi
    .fn()
    .mockImplementation((url: string | URL, options: RequestInit) => {
      if (String(url).includes('api.github.com'))
        return Promise.resolve(redirect());
      if (options.method === 'HEAD')
        return Promise.resolve(
          new Response(null, {
            headers: { 'content-length': String(Buffer.byteLength(body)) },
          }),
        );
      return Promise.resolve(new Response(body));
    });
  vi.stubGlobal('fetch', fetch);
  const scheduler = new GitHubReadScheduler();
  const result = await scheduler.readJobLog(repo, jobId);
  expect(result).toEqual({
    text: 'Error [redacted] [redacted]\nAuthorization: Bearer [redacted]',
    truncated: false,
  });
  const api = fetch.mock.calls[0][1] as RequestInit;
  expect(api.headers).toMatchObject({ Authorization: 'Bearer private-token' });
  for (const [, options] of fetch.mock.calls.slice(1)) {
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect((options as RequestInit).headers ?? {}).not.toHaveProperty(
      'Authorization',
    );
  }
  expect(JSON.stringify(result)).not.toMatch(
    /private-token|private-signature|another-value|ghp_/,
  );
  await scheduler.readJobLog(repo, jobId);
  expect(fetch).toHaveBeenCalledTimes(6);
});

it.each([
  'http://productionresultssa4.blob.core.windows.net/file',
  'https://127.0.0.1/file',
  'https://attacker.invalid/log',
  'https://productionresultssa4.blob.core.windows.net.attacker.invalid/file',
  'https://unrelated.blob.core.windows.net/file',
  'https://user:pass@productionresultssa4.blob.core.windows.net/file',
  'https://productionresultssa4.blob.core.windows.net:8443/file',
])(
  'rejects a redirected log URL outside the fixed HTTPS storage scope: %s',
  async (url) => {
    const fetch = vi.fn(() => Promise.resolve(redirect(url)));
    vi.stubGlobal('fetch', fetch);
    await expect(
      new GitHubReadScheduler().readJobLog(repo, jobId),
    ).rejects.toThrow('GIT_GITHUB_LOGS_HOST_UNSUPPORTED');
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('uses a verified byte range for a large log and explicitly reports a truncated tail', async () => {
  const size = 10000000;
  const body = 'x'.repeat(65530) + 'ERROR!';
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(redirect())
    .mockResolvedValueOnce(
      new Response(null, { headers: { 'content-length': String(size) } }),
    )
    .mockResolvedValueOnce(
      new Response(body, {
        status: 206,
        headers: {
          'content-range': `bytes ${size - 65536}-${size - 1}/${size}`,
        },
      }),
    );
  vi.stubGlobal('fetch', fetch);
  const result = await new GitHubReadScheduler().readJobLog(repo, jobId);
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16384);
  expect(result.text.endsWith('ERROR!')).toBe(true);
  expect(result.truncated).toBe(true);
  expect(fetch.mock.calls[2][1]).toMatchObject({
    headers: { Range: `bytes=${size - 65536}-${size - 1}` },
  });
});

it('keeps the UTF-8 excerpt within its byte limit without splitting a character', async () => {
  const body = '€'.repeat(10000);
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { 'content-length': String(Buffer.byteLength(body)) },
        }),
      )
      .mockResolvedValueOnce(new Response(body)),
  );
  const result = await new GitHubReadScheduler().readJobLog(repo, jobId);
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16384);
  expect(result.text).not.toContain('\ufffd');
  expect(result.truncated).toBe(true);
});

it('rejects oversized/partial bodies and a server that ignores the requested tail range', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(
        new Response(null, { headers: { 'content-length': '70000' } }),
      )
      .mockResolvedValueOnce(new Response('ignored range')),
  );
  await expect(
    new GitHubReadScheduler().readJobLog(repo, jobId),
  ).rejects.toThrow('GIT_GITHUB_LOGS_UNAVAILABLE');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(
        new Response(null, { headers: { 'content-length': '10' } }),
      )
      .mockResolvedValueOnce(new Response('x'.repeat(65537))),
  );
  await expect(
    new GitHubReadScheduler().readJobLog(repo, jobId),
  ).rejects.toThrow('GIT_GITHUB_LOGS_TOO_LARGE');
});

it('stops after revocation without fetching the signed URL and keeps permission/rate errors explicit', async () => {
  let active = true;
  const fetch = vi.fn(() => {
    active = false;
    return Promise.resolve(redirect());
  });
  vi.stubGlobal('fetch', fetch);
  await expect(
    new GitHubReadScheduler().readJobLog(repo, jobId, () => {
      if (!active) throw new Error('revoked');
    }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  for (const [status, code] of [
    [401, 'GIT_GITHUB_AUTH'],
    [403, 'GIT_GITHUB_ACCESS'],
    [404, 'GIT_GITHUB_LOGS_UNAVAILABLE'],
    [429, 'GIT_GITHUB_RATE_LIMIT'],
  ] as const) {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status }))),
    );
    await expect(
      new GitHubReadScheduler().readJobLog(repo, jobId),
    ).rejects.toThrow(code);
  }
});

it('keeps the proxy public-only and permits only the dedicated Actions log storage pattern', () => {
  const config = readFileSync('deployment/config/squid.conf', 'utf8');
  expect(config).toContain(
    'acl github_actions_logs dstdom_regex ^productionresultssa[0-9]+\\.blob\\.core\\.windows\\.net$',
  );
  expect(config).not.toContain('dstdomain .blob.core.windows.net');
  expect(config.indexOf('http_access deny private_ipv4')).toBeLessThan(
    config.indexOf('http_access allow github_actions_logs'),
  );
  expect(config.indexOf('http_access deny private_ipv6')).toBeLessThan(
    config.indexOf('http_access allow github_actions_logs'),
  );
});
