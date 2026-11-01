import {
  Body,
  Controller,
  Get,
  Post,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { requireExecutionAccess } from '../auth/access-context';
import { AppCatalogService } from './app-catalog.service';

@ApiTags('apps')
@ApiBearerAuth()
@Controller('apps/catalog')
export class AppCatalogController {
  constructor(private readonly catalog: AppCatalogService) {}
  @Get('status')
  @ApiOperation({
    summary:
      'Read daily application directory status and bounded attempt journal (administrator)',
  })
  async status() {
    requireExecutionAccess();
    return {
      ...this.catalog.status(),
      worker: await this.catalog.workerStatus(),
    };
  }
  @Post('source')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['source'],
      properties: { source: { type: 'string', enum: ['native', 'byparr'] } },
    },
  })
  @ApiOperation({
    summary: 'Enable or disable the daily directory workaround (administrator)',
  })
  setSource(@Body('source') source: unknown) {
    requireExecutionAccess();
    if (source !== 'native' && source !== 'byparr')
      throw new BadRequestException('Invalid catalog source');
    return this.catalog.setSource(source);
  }
}
