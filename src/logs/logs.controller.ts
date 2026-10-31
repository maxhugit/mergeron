/** REST controller for structured logs and sanitized diagnostics export. */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  Query,
} from '@nestjs/common';
import { LogRetentionService } from './log-retention.service';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import {
  LogsExportResponseDto,
  LogsQueryDto,
  LogsResponseDto,
} from './dto/logs.dto';
import {
  LogsService,
  type LogsExportResponse,
  type LogsResponse,
} from './logs.service';

@ApiTags('logs')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@Controller('logs')
export class LogsController {
  constructor(
    private readonly logsService: LogsService,
    private readonly retention: LogRetentionService,
  ) {}

  @Get('storage')
  storage() {
    return this.retention.storage();
  }

  @Put('retention')
  retentionPolicy(@Body() body: unknown) {
    return this.retention.update(body);
  }

  @Patch('retention/:family')
  retentionFamily(@Param('family') family: string, @Body() body: unknown) {
    return this.retention.updateFamily(family, body);
  }

  /** Reads paginated structured application logs. */
  @Get()
  @ApiOperation({ summary: 'List structured application logs' })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'level', required: false })
  @ApiQuery({ name: 'source', required: false })
  @ApiQuery({ name: 'levels', required: false })
  @ApiQuery({ name: 'sources', required: false })
  @ApiOkResponse({ type: LogsResponseDto })
  async listLogs(@Query() query: LogsQueryDto): Promise<LogsResponse> {
    return this.logsService.listLogs(query);
  }

  /** Exports a sanitized diagnostic bundle for issue reports. */
  @Get('export')
  @ApiOperation({ summary: 'Export sanitized diagnostics bundle' })
  @ApiOkResponse({ type: LogsExportResponseDto })
  async exportDiagnostics(): Promise<LogsExportResponse> {
    return this.logsService.exportDiagnostics();
  }
}
