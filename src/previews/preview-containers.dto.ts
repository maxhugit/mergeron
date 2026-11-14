import { ApiProperty } from '@nestjs/swagger';
export class PreviewContainerMemoryDto {
  @ApiProperty({ type: Number, nullable: true }) usageBytes!: number | null;
  @ApiProperty({ type: Number, nullable: true }) limitBytes!: number | null;
  @ApiProperty({ type: Number, nullable: true }) anonymousBytes!: number | null;
  @ApiProperty({ type: Number, nullable: true }) fileBytes!: number | null;
  @ApiProperty({ type: Number, nullable: true }) sharedBytes!: number | null;
  @ApiProperty() oomKilled!: boolean;
}
export class PreviewContainerDto {
  @ApiProperty() component!: string;
  @ApiProperty() name!: string;
  @ApiProperty() image!: string;
  @ApiProperty() state!: string;
  @ApiProperty({ type: String, nullable: true }) startedAt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) cpuPercent!: number | null;
  @ApiProperty({ type: Number, nullable: true }) memoryBytes!: number | null;
  @ApiProperty({ type: Number, nullable: true }) metricsCheckedAt!:
    | number
    | null;
  @ApiProperty({ type: PreviewContainerMemoryDto, nullable: true })
  memory!: PreviewContainerMemoryDto | null;
  @ApiProperty() terminalAvailable!: boolean;
}
export class PreviewContainersDto {
  @ApiProperty() runId!: string;
  @ApiProperty({ type: [PreviewContainerDto] })
  containers!: PreviewContainerDto[];
}
