import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AgentPreferencesDto {
  @ApiProperty() personId!: string;
  @ApiProperty({ maxLength: 8000 }) instructions!: string;
  @ApiProperty({ enum: ['message', 'fr', 'en'] }) language!: string;
}
export class AgentInstructionSourceInputDto {
  @ApiProperty({ type: String, nullable: true }) copyId!: string | null;
  @ApiProperty({ minimum: 0 }) version!: number;
}
export class AgentContextSourceDto {
  @ApiProperty() kind!: string;
  @ApiProperty() revision!: string;
  @ApiPropertyOptional({ type: [String] }) files?: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) commit?: string | null;
}
export class AgentContextEventDto {
  @ApiProperty() id!: string;
  @ApiProperty() trigger!: string;
  @ApiProperty() state!: string;
  @ApiProperty({ type: String, nullable: true }) revision!: string | null;
  @ApiProperty({ type: [AgentContextSourceDto] })
  sources!: AgentContextSourceDto[];
  @ApiProperty() createdAt!: number;
}
export class AgentContextStatusDto {
  @ApiProperty() threadId!: string;
  @ApiProperty({ type: String, nullable: true }) copyId!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ type: [AgentContextEventDto] })
  events!: AgentContextEventDto[];
}
export class GitInstructionFileDto {
  @ApiProperty() path!: string;
  @ApiProperty() text!: string;
}
export class GitInstructionPreviewDto {
  @ApiProperty({ type: [GitInstructionFileDto] })
  files!: GitInstructionFileDto[];
  @ApiProperty() commit!: string;
  @ApiProperty() revision!: string;
}
