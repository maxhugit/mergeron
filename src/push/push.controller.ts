import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { PushService } from './push.service';
import { IdentityService } from '../auth/identity.service';

@ApiTags('push')
@Controller('push')
export class PushController {
  constructor(
    private readonly push: PushService,
    private readonly identities: IdentityService,
  ) {}
  private identity(request: IdentityRequest) {
    return (
      request.platformIdentity ??
      this.identities.resolve(request.headers, request.authenticatedPersonId)
    );
  }
  @Get() @Header('Cache-Control', 'no-store') status(
    @Req() request: IdentityRequest,
  ) {
    return this.push.status(this.identity(request));
  }
  @Post('subscriptions') subscribe(
    @Req() request: IdentityRequest,
    @Body() body: unknown,
  ) {
    return this.push.subscribe(this.identity(request), body);
  }
  @Patch('subscriptions/:id') preferences(
    @Req() request: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.push.preferences(this.identity(request), id, body);
  }
  @Delete('subscriptions/:id') remove(
    @Req() request: IdentityRequest,
    @Param('id') id: string,
  ) {
    return this.push.remove(this.identity(request), id);
  }
  @Post('subscriptions/:id/test') test(
    @Req() request: IdentityRequest,
    @Param('id') id: string,
  ) {
    return this.push.test(this.identity(request), id);
  }
}
