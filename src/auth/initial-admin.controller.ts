import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from './public.decorator';
import { InitialAdminService } from './initial-admin.service';

@Controller('auth/setup')
export class InitialAdminController {
  constructor(private readonly setup: InitialAdminService) {}
  private check(request: FastifyRequest) {
    this.setup.requireOrigin(request.headers.origin);
    if (
      request.headers['content-type']?.split(';')[0].trim() !==
      'application/json'
    )
      throw new UnsupportedMediaTypeException('Setup requires JSON');
  }
  @Public()
  @Get('status')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  status(@Req() request: FastifyRequest) {
    return this.setup.status(request.headers.cookie);
  }
  @Public()
  @Post('verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  verify(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: { code?: unknown },
  ) {
    this.check(request);
    const result = this.setup.verify(body?.code);
    reply.header(
      'set-cookie',
      this.setup.cookie(result.grant, result.expiresAt),
    );
    return { authorized: true, csrfToken: result.csrfToken };
  }
  @Public()
  @Post('complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async complete(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    this.check(request);
    const result = await this.setup.complete(request.headers.cookie, body);
    reply.header('set-cookie', this.setup.cookie());
    return result;
  }
}
