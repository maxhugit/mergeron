import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { IdentityService } from '../auth/identity.service';
import { NotificationsService } from './notifications.service';
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly service: NotificationsService,
    private readonly identities: IdentityService,
  ) {}
  private identity(r: IdentityRequest) {
    return (
      r.platformIdentity ??
      this.identities.resolve(r.headers, r.authenticatedPersonId)
    );
  }
  @Get() @Header('Cache-Control', 'no-store') list(
    @Req() r: IdentityRequest,
    @Query('filter') filter?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list(this.identity(r), filter, cursor);
  }
  @Get('preferences') @Header('Cache-Control', 'no-store') preference(
    @Req() r: IdentityRequest,
  ) {
    return this.service.preference(this.identity(r));
  }
  @Patch('preferences') setPreference(
    @Req() r: IdentityRequest,
    @Body() b: { retentionDays?: unknown },
  ) {
    return this.service.setPreference(this.identity(r), b?.retentionDays);
  }
  @Patch(':id/read') read(
    @Req() r: IdentityRequest,
    @Param('id') id: string,
    @Body() b: { read?: unknown },
  ) {
    return this.service.read(this.identity(r), id, b?.read);
  }
  @Post('errors') error(
    @Req() r: IdentityRequest,
    @Body() b: Parameters<NotificationsService['error']>[1],
  ) {
    return this.service.error(this.identity(r), b);
  }
}
