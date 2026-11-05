import { Body, Controller, Get, Put } from '@nestjs/common';
import { requireExecutionAccess } from '../auth/access-context';
import { LocalAgentsService } from './local-agents.service';
@Controller('local-agents')
export class LocalAgentsController {
  constructor(private readonly local: LocalAgentsService) {}
  @Get('configuration') read() {
    requireExecutionAccess();
    return this.local.configuration();
  }
  @Put('configuration') configure(@Body() input: unknown) {
    requireExecutionAccess();
    return this.local.configure(input);
  }
  @Get('models') models() {
    return this.local.catalog();
  }
}
