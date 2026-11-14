import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export class GitRemoteObservationDto {
  @ApiProperty() branch!: string;
  @ApiProperty() sha!: string;
  @ApiProperty() checkedAt!: number;
  @ApiProperty({ enum: ['push', 'fetch'] }) source!: 'push' | 'fetch';
  @ApiProperty() ahead!: number;
  @ApiProperty() behind!: number;
}
export class GitSnapshotChangeDto {
  @ApiProperty() path!: string;
  @ApiPropertyOptional() originalPath?: string;
  @ApiProperty() status!: string;
}
export class GitSnapshotBranchDto {
  @ApiProperty() name!: string;
  @ApiProperty() remote!: boolean;
  @ApiProperty() revision!: string;
  @ApiProperty() upstream!: string;
  @ApiProperty() tracking!: string;
}
export class GitSnapshotDto {
  @ApiPropertyOptional({ type: GitRemoteObservationDto, nullable: true })
  remoteObservation?: GitRemoteObservationDto | null;
  @ApiProperty() fingerprint!: string;
  @ApiProperty({ type: String, nullable: true }) branch!: string | null;
  @ApiProperty() head!: string;
  @ApiProperty() ahead!: number;
  @ApiProperty() behind!: number;
  @ApiProperty({ type: String, nullable: true }) upstream!: string | null;
  @ApiProperty() branchesLimited!: boolean;
  @ApiProperty() inspectedAt!: number;
  @ApiProperty({ type: [GitSnapshotChangeDto] })
  changes!: GitSnapshotChangeDto[];
  @ApiProperty({ type: [GitSnapshotBranchDto] })
  branches!: GitSnapshotBranchDto[];
}
