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
