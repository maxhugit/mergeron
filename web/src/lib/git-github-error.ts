const messages = {
  GIT_GITHUB_TIMEOUT: 'gitGithubTimeout',
  GIT_GITHUB_NETWORK: 'gitGithubNetwork',
  GIT_GITHUB_RATE_LIMIT: 'gitGithubRateLimit',
  GIT_GITHUB_AUTH: 'gitGithubAuth',
  GIT_GITHUB_ACCESS: 'gitGithubAccess',
  GIT_GITHUB_UNAVAILABLE: 'gitGithubUnavailable',
  GIT_GITHUB_BUSY: 'gitGithubBusy',
} as const;

export function gitGithubErrorKey(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return messages[code as keyof typeof messages] ?? 'gitGithubError';
}
