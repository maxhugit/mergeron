import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { CodexCliService } from './codex-cli.service';

export class ChangeCliDto {
  @ApiProperty({ required: false, example: '0.154.0' })
  targetVersion?: string;
  @ApiProperty({ example: '0.153.2' })
  expectedVersion!: string;
}

export class InstallCliDto {
  @ApiProperty({ example: '0.163.0' })
  targetVersion!: string;
}

@ApiTags('codex')
@ApiBearerAuth()
@Controller('codex/cli')
export class CodexCliController {
  constructor(private readonly cli: CodexCliService) {}
  @Get()
  @ApiOperation({
    summary: 'Read installed CLI version and latest stable npm release',
  })
  status(@Query('refresh') refresh?: string) {
    return this.cli.status(refresh === 'true');
  }
  @Post('managed')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Install the Manager-shipped validated CLI and activate it while idle',
  })
  managed(
    @Body()
    body: {
      releaseId?: string;
      manifestSha256?: string;
      expectedSelection?: string | null;
    },
  ) {
    return this.cli.installManaged(body ?? {});
  }
  @Get('releases')
  @ApiOperation({
    summary: 'List official stable release notes between installed and latest',
  })
  releases(@Query('refresh') refresh?: string) {
    return this.cli.releaseNotes(refresh === 'true');
  }
  @Post('install')
  @HttpCode(200)
  @ApiOperation({ summary: 'Install and activate the first managed CLI' })
  install(@Body() body: InstallCliDto) {
    return this.cli.installFirst(body?.targetVersion);
  }
  @Post('update')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Install and activate the latest stable CLI while idle',
  })
  update(@Body() body: ChangeCliDto) {
    return this.cli.change(body?.expectedVersion, false, body?.targetVersion);
  }
  @Post('rollback')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Return to the previous CLI installation while idle',
  })
  rollback(@Body() body: ChangeCliDto) {
    return this.cli.change(body?.expectedVersion, true);
  }
}
