import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Only transport fields: no raw TOML, arbitrary headers or inline secrets. */
export class McpServerConfigDto {
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['http', 'stdio'] }) transport!: 'http' | 'stdio';
  @ApiPropertyOptional() url?: string;
  @ApiPropertyOptional() command?: string;
  @ApiPropertyOptional({ type: [String] }) args?: string[];
  @ApiPropertyOptional() bearerTokenEnvVar?: string;
  @ApiPropertyOptional() update?: boolean;
}
export class McpServerSavedDto {
  @ApiProperty() name!: string;
  @ApiProperty() saved!: boolean;
  @ApiProperty() reloadRequired!: boolean;
}
