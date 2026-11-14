import { ApiProperty } from '@nestjs/swagger';
export class PreviewExecutionDto {
  @ApiProperty() runtime!: string;
  @ApiProperty({ enum: ['development', 'production', 'test', 'unknown'] })
  nodeEnv!: string;
  @ApiProperty() directory!: string;
  @ApiProperty() updateMode!: string;
}
export class PreviewTerminationDto {
  @ApiProperty({
    enum: [
      'memory_limit',
      'process_exit',
      'startup_timeout',
      'expired',
      'user_stop',
    ],
  })
  cause!: string;
  @ApiProperty({ type: Number }) observedAt!: number;
  @ApiProperty({ type: Number, nullable: true }) exitCode!: number | null;
  @ApiProperty() oomKilled!: boolean;
  @ApiProperty({ type: String, nullable: true }) finishedAt!: string | null;
}
export class PreviewDiagnosticsDto {
  @ApiProperty({ type: String, nullable: true }) runId!: string | null;
  @ApiProperty() state!: string;
  @ApiProperty({ type: PreviewExecutionDto, nullable: true })
  execution!: PreviewExecutionDto | null;
  @ApiProperty({ type: PreviewTerminationDto, nullable: true })
  termination!: PreviewTerminationDto | null;
}
/** Manager observations are projected explicitly; never return arbitrary env or Docker state. */
export function previewDiagnostics(
  observed: Record<string, unknown>,
): PreviewDiagnosticsDto {
  const execution = observed.execution as Record<string, unknown> | null;
  const termination = observed.termination as Record<string, unknown> | null;
  const causes = [
    'memory_limit',
    'process_exit',
    'startup_timeout',
    'expired',
    'user_stop',
  ];
  return {
    runId: typeof observed.runId === 'string' ? observed.runId : null,
    state: typeof observed.state === 'string' ? observed.state : 'unknown',
    execution:
      execution &&
      typeof execution.runtime === 'string' &&
      typeof execution.directory === 'string'
        ? {
            runtime: execution.runtime,
            nodeEnv:
              execution.nodeEnv === 'development' ||
              execution.nodeEnv === 'production' ||
              execution.nodeEnv === 'test'
                ? execution.nodeEnv
                : 'unknown',
            directory: execution.directory,
            updateMode:
              execution.updateMode === 'hot'
                ? 'hot'
                : execution.updateMode === 'restart'
                  ? 'restart'
                  : execution.updateMode === 'manual'
                    ? 'manual'
                    : 'unknown',
          }
        : null,
    termination:
      termination &&
      causes.includes(String(termination.cause)) &&
      Number.isSafeInteger(termination.observedAt)
        ? {
            cause: String(termination.cause),
            observedAt: Number(termination.observedAt),
            exitCode:
              Number.isInteger(termination.exitCode) &&
              Number(termination.exitCode) >= 0 &&
              Number(termination.exitCode) <= 255
                ? Number(termination.exitCode)
                : null,
            oomKilled: termination.oomKilled === true,
            finishedAt:
              typeof termination.finishedAt === 'string' &&
              Number.isFinite(Date.parse(termination.finishedAt))
                ? termination.finishedAt
                : null,
          }
        : null,
  };
}
