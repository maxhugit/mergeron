import { ConflictException } from '@nestjs/common';

export const GITHUB_LOG_STORAGE_HOST =
  /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/;
type Repo = { owner: string; repo: string; token?: string };

/** Only follow a GitHub-issued log link, without forwarding its API credentials. */
export async function readGitHubJobLog(
  repo: Repo,
  jobId: number,
  signal: AbortSignal,
  assertActive: () => void,
  refuse: (response: Response) => never,
) {
  assertActive();
  const redirect = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/actions/jobs/${jobId}/logs`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(repo.token ? { Authorization: `Bearer ${repo.token}` } : {}),
      },
      redirect: 'manual',
      signal,
    },
  );
  await redirect.body?.cancel();
  assertActive();
  if (redirect.status !== 302) refuse(redirect);
  let target: URL;
  try {
    target = new URL(redirect.headers.get('location') ?? '');
  } catch {
    throw new ConflictException('GIT_GITHUB_LOGS_HOST_UNSUPPORTED');
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.hash ||
    (target.port && target.port !== '443') ||
    !GITHUB_LOG_STORAGE_HOST.test(target.hostname)
  )
    throw new ConflictException('GIT_GITHUB_LOGS_HOST_UNSUPPORTED');
  // Inspect size first so even very large logs yield a useful bounded tail.
  // The signed URL is never persisted, returned or logged. No second redirect.
  const request = async (
    method: 'HEAD' | 'GET',
    headers?: Record<string, string>,
  ) => {
    assertActive();
    const response = await fetch(target, {
      method,
      headers,
      credentials: 'omit',
      redirect: 'error',
      signal,
    });
    try {
      assertActive();
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    return response;
  };
  const info = await request('HEAD');
  await info.body?.cancel();
  const length = info.headers.get('content-length');
  const size = length && /^\d+$/.test(length) ? Number(length) : NaN;
  if (!info.ok || !Number.isSafeInteger(size) || size < 0)
    throw new ConflictException('GIT_GITHUB_LOGS_UNAVAILABLE');
  if (!size) return { text: '', truncated: false };
  const start = Math.max(0, size - 65536);
  const response = await request('GET', {
    Range: `bytes=${start}-${size - 1}`,
  });
  if (
    !response.ok ||
    (start > 0 && response.status !== 206) ||
    (response.status === 206 &&
      response.headers.get('content-range') !==
        `bytes ${start}-${size - 1}/${size}`)
  ) {
    await response.body?.cancel();
    throw new ConflictException('GIT_GITHUB_LOGS_UNAVAILABLE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ConflictException('GIT_GITHUB_LOGS_UNAVAILABLE');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 65536)
        throw new ConflictException('GIT_GITHUB_LOGS_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  if (bytes !== size - start)
    throw new ConflictException('GIT_GITHUB_LOGS_UNAVAILABLE');
  assertActive();
  let output = Buffer.concat(chunks).toString('utf8');
  // GitHub also masks configured Actions secrets. Do not echo our own credential
  // if a workflow prints it, including common URL-encoded representations.
  if (repo.token)
    for (const token of [repo.token, encodeURIComponent(repo.token)])
      output = output.replaceAll(token, '[redacted]');
  output = output
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)\b/g,
      '[redacted]',
    )
    .replace(
      /(authorization\s*[:=]\s*(?:bearer|basic)\s+)\S+/gi,
      '$1[redacted]',
    )
    .replace(/https?:\/\/[^\s/@]+@/g, 'https://[redacted]@')
    // eslint-disable-next-line no-control-regex -- Strip terminal ANSI sequences from untrusted job output.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const bounded = Buffer.from(output);
  let offset = Math.max(0, bounded.length - 16384);
  while (offset < bounded.length && (bounded[offset] & 0xc0) === 0x80) offset++;
  return {
    text: bounded.subarray(offset).toString('utf8'),
    truncated: start > 0 || bounded.length > 16384,
  };
}
