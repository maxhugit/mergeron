import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IdentityService } from '../auth/identity.service';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { BrowserService } from './browser.service';
@Controller('browser/:threadId')
export class BrowserController {
  constructor(
    private readonly browser: BrowserService,
    private readonly identities: IdentityService,
  ) {}
  @Post(':action')
  run(
    @Param('threadId') threadId: string,
    @Param('action') action: string,
    @Body() body: Record<string, unknown>,
    @Req() request: IdentityRequest,
  ) {
    const identity = request.platformIdentity;
    if (!identity)
      throw new ServiceUnavailableException('Identity unavailable');
    this.identities.requireThread(identity, threadId);
    // Remote page actions can mutate external services. Keep the existing
    // administrator-only server-execution boundary, including impersonation.
    this.identities.requireAdministrator(identity);
    const owner = identity.personId ?? identity.subject ?? identity.kind;
    return this.browser.run(
      JSON.stringify([
        owner,
        identity.impersonation?.sessionId ?? '',
        threadId,
      ]),
      action,
      body ?? {},
    );
  }
}
