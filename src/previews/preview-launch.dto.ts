import { ApiProperty } from '@nestjs/swagger';
export class PreviewExecutionIssueDto {
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['error', 'warning'] }) severity!: string;
}
export class PreviewExecutionCheckDto {
  @ApiProperty() valid!: boolean;
  @ApiProperty({ enum: ['development', 'production', 'test', 'unknown'] })
  mode!: string;
  @ApiProperty({ type: Number }) port!: number;
  @ApiProperty({ enum: ['development', 'production', 'custom'] }) kind!: string;
  @ApiProperty({ type: [PreviewExecutionIssueDto] })
  issues!: PreviewExecutionIssueDto[];
}
export class PreviewLaunchConfigurationDto {
  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    properties: {
      storageBudget: {
        type: 'object',
        additionalProperties: false,
        required: ['workspaceMb', 'cacheMb', 'temporaryMb', 'dataMb'],
        properties: {
          workspaceMb: { type: 'integer', minimum: 64, maximum: 4096 },
          cacheMb: { type: 'integer', minimum: 16, maximum: 2048 },
          temporaryMb: { type: 'integer', minimum: 16, maximum: 512 },
          dataMb: { type: 'integer', minimum: 16, maximum: 256 },
        },
      },
    },
  })
  profile!: Record<string, unknown> | null;
  @ApiProperty({ type: PreviewExecutionCheckDto, nullable: true })
  executionCheck!: PreviewExecutionCheckDto | null;
  @ApiProperty() policyRevision!: string;
  @ApiProperty({ type: String, nullable: true }) recipeRevision!: string | null;
  @ApiProperty({ type: String, nullable: true }) revision!: string | null;
  @ApiProperty() agentManaged!: boolean;
  @ApiProperty() stale!: boolean;
  @ApiProperty({ type: String, nullable: true }) sourcePath!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceError!: string | null;
}
