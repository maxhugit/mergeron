import { expect, it } from 'vitest';
import { previewDiagnostics } from './preview-diagnostics.dto';
it('projects only known launch and termination evidence without exposing environment values', () => {
  const result = previewDiagnostics({
    runId: 'run',
    state: 'failed',
    execution: {
      runtime: 'node',
      directory: '.',
      nodeEnv: 'private-environment-value',
      updateMode: 'manual',
      PASSWORD: 'never-return',
    },
    termination: {
      cause: 'process_exit',
      observedAt: 1234,
      exitCode: 137,
      oomKilled: false,
      finishedAt: 'not-a-date',
      Error: 'raw-docker-error',
    },
  });
  expect(result.execution?.nodeEnv).toBe('unknown');
  expect(result.execution?.updateMode).toBe('manual');
  expect(result.termination).toEqual({
    cause: 'process_exit',
    observedAt: 1234,
    exitCode: 137,
    oomKilled: false,
    finishedAt: null,
  });
  expect(JSON.stringify(result)).not.toMatch(
    /private-environment-value|never-return|raw-docker-error/,
  );
  expect(previewDiagnostics({}).execution).toBeNull();
  expect(
    previewDiagnostics({ termination: { cause: 'invented', observedAt: 1 } })
      .termination,
  ).toBeNull();
});

it('exposes only version-shaped runtime measurements, never package metadata or environment', () => {
  const result = previewDiagnostics({
    runtimeVersions: {
      checkedAt: 1234,
      node: '22.23.3',
      npm: '10.9.0',
      pnpm: 'secret',
      corepack: null,
      env: 'private',
    },
  });
  expect(result.runtimeVersions).toEqual({
    checkedAt: 1234,
    node: '22.23.3',
    npm: '10.9.0',
    pnpm: null,
    corepack: null,
  });
});
