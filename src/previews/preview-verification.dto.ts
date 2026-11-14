import { ApiProperty } from '@nestjs/swagger';

/** Personal, short-lived browser bootstrap. Never expose through agent tools. */
export class PreviewVerificationOpenDto {
  @ApiProperty({ type: String, format: 'uri' })
  url!: string;

  @ApiProperty({ type: Number, description: 'Expiry as Unix milliseconds' })
  expiresAt!: number;
}
