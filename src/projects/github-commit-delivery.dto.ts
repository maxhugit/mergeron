import { ApiProperty } from '@nestjs/swagger';
export class GitCommitWorkflowDto {
  @ApiProperty() id!: number;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ type: String, nullable: true }) event!: string | null;
  @ApiProperty({ type: String, nullable: true }) branch!: string | null;
  @ApiProperty() revision!: string;
  @ApiProperty({ type: Number, nullable: true }) attempt!: number | null;
  @ApiProperty({ type: String, nullable: true }) status!: string | null;
  @ApiProperty({ type: String, nullable: true }) conclusion!: string | null;
  @ApiProperty({ type: String, nullable: true }) createdAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) updatedAt!: string | null;
  @ApiProperty() url!: string;
}
export class GitCommitActionsDto {
  @ApiProperty() total!: number;
  @ApiProperty() limited!: boolean;
  @ApiProperty({ type: Number, nullable: true }) nextPage!: number | null;
  @ApiProperty() inspectedAt!: number;
  @ApiProperty({ type: [GitCommitWorkflowDto] }) items!: GitCommitWorkflowDto[];
}
export class GitImageEvidenceDto {
  @ApiProperty({ enum: ['unverified'] }) state!: 'unverified';
  @ApiProperty({ enum: ['registry_receipt_required'] })
  reason!: 'registry_receipt_required';
}
export class GitDeploymentEvidenceDto {
  @ApiProperty({ enum: ['unverified'] }) state!: 'unverified';
  @ApiProperty({ enum: ['runtime_receipt_required'] })
  reason!: 'runtime_receipt_required';
}
export class GitCommitDeliveryDto {
  @ApiProperty() revision!: string;
  @ApiProperty() repository!: string;
  @ApiProperty() commitUrl!: string;
  @ApiProperty() inspectedAt!: number;
  @ApiProperty({ type: GitCommitActionsDto }) actions!: GitCommitActionsDto;
  @ApiProperty({ type: GitImageEvidenceDto }) image!: GitImageEvidenceDto;
  @ApiProperty({ type: GitDeploymentEvidenceDto })
  deployment!: GitDeploymentEvidenceDto;
}
