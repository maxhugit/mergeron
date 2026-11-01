import { ApiProperty } from '@nestjs/swagger';

/** Committed runtime inventory; does not fetch the public app directory. */
export class InstalledAppDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, nullable: true }) runtimeName!: string | null;
  @ApiProperty() enabled!: boolean;
  @ApiProperty() callable!: boolean;
}

export class InstalledAppsResponseDto {
  @ApiProperty({ type: () => [InstalledAppDto] }) apps!: InstalledAppDto[];
}
