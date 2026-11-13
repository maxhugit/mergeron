import { ApiOkResponse, ApiBody } from '@nestjs/swagger';
import {
  AgentPreferencesDto,
  AgentInstructionSourceInputDto,
  AgentContextStatusDto,
  GitInstructionPreviewDto,
} from './agent-context.dto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Header,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { AgentContextService } from './agent-context.service';

@Controller('agent-context')
export class AgentContextController {
  constructor(private readonly context: AgentContextService) {}

  @ApiOkResponse({ type: AgentPreferencesDto })
  @Header('Cache-Control', 'no-store')
  @Get('profile')
  profile() {
    return this.context.profile();
  }

  @ApiOkResponse({ type: AgentPreferencesDto })
  @ApiBody({ type: AgentPreferencesDto })
  @Header('Cache-Control', 'no-store')
  @Patch('profile')
  saveProfile(
    @Body()
    body: {
      instructions?: unknown;
      language?: unknown;
      personId?: unknown;
    },
  ) {
    return this.context.profile(body);
  }

  @ApiOkResponse({ type: AgentContextStatusDto })
  @Header('Cache-Control', 'no-store')
  @Get('agents/:threadId')
  status(@Param('threadId') threadId: string) {
    return this.context.status(threadId);
  }

  @ApiOkResponse({ type: AgentContextStatusDto })
  @ApiBody({ type: AgentInstructionSourceInputDto })
  @Header('Cache-Control', 'no-store')
  @Patch('agents/:threadId/source')
  associate(
    @Param('threadId') threadId: string,
    @Body() body: { copyId?: unknown; version?: unknown },
  ) {
    return this.context.associate(threadId, body);
  }

  @ApiOkResponse({ type: GitInstructionPreviewDto })
  @Header('Cache-Control', 'no-store')
  @Get('agents/:threadId/preview')
  preview(@Param('threadId') threadId: string) {
    return this.context.preview(threadId);
  }

  @ApiOkResponse({ type: AgentContextStatusDto })
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Post('agents/:threadId/verify')
  async verify(@Param('threadId') threadId: string) {
    await this.context.prepare(threadId, 'manual');
    return this.context.status(threadId);
  }
}
