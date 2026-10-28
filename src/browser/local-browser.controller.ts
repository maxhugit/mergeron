import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { IdentityService } from '../auth/identity.service';
import { LocalBrowserService } from './local-browser.service';

@Controller('browser-local/:threadId')
export class LocalBrowserController {
  constructor(
    private readonly local: LocalBrowserService,
    private readonly identities: IdentityService,
  ) {}
  private owner(threadId: string, request: IdentityRequest) {
    const identity = request.platformIdentity;
    if (!identity || identity.impersonation)
      throw new ForbiddenException('Local browser unavailable');
    this.identities.requireActive(identity);
    this.identities.requireAdministrator(identity);
    this.identities.requireThread(identity, threadId);
    return identity.personId ?? identity.subject ?? identity.kind;
  }
  @Post('open') open(
    @Param('threadId') thread: string,
    @Req() request: IdentityRequest,
  ) {
    return this.local.open(this.owner(thread, request), thread);
  }
  @Get('status') status(
    @Param('threadId') thread: string,
    @Req() request: IdentityRequest,
  ) {
    return this.local.status(this.owner(thread, request), thread);
  }
  @Post(':id/poll') poll(
    @Param('threadId') thread: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: IdentityRequest,
  ) {
    return this.local.poll(this.owner(thread, request), thread, id, body);
  }
  @Post(':id/decide') decide(
    @Param('threadId') thread: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: IdentityRequest,
  ) {
    return this.local.decide(
      this.owner(thread, request),
      thread,
      id,
      String(body?.commandId),
      body?.approve,
    );
  }
  @Post(':id/close') close(
    @Param('threadId') thread: string,
    @Param('id') id: string,
    @Req() request: IdentityRequest,
  ) {
    return this.local.close(this.owner(thread, request), thread, id);
  }
}
