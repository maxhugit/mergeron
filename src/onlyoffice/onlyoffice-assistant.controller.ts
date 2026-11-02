import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Public } from '../auth/public.decorator';
import { SettingsService } from '../settings/settings.service';
import { GENERAL_SETTING_KEYS } from '../settings/settings.definitions';
import {
  OFFICE_ASSISTANT_GUID,
  OnlyOfficeAssistantService,
} from './onlyoffice-assistant.service';

@ApiTags('onlyoffice')
@Controller('onlyoffice/assistant')
export class OnlyOfficeAssistantController {
  constructor(
    private readonly assistant: OnlyOfficeAssistantService,
    private readonly settings: SettingsService,
  ) {}

  @Post('context')
  @Header('Cache-Control', 'private, no-store')
  context(@Body('sessionId') sessionId: unknown) {
    return this.assistant.context(sessionId);
  }

  @Post('proposals')
  @Header('Cache-Control', 'private, no-store')
  propose(@Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Invalid document request');
    const request = body as Record<string, unknown>;
    return this.assistant.propose(request.sessionId, request);
  }

  @Post('proposals/:id')
  @Header('Cache-Control', 'private, no-store')
  read(@Body('sessionId') sessionId: unknown, @Param('id') id: string) {
    return this.assistant.read(sessionId, id);
  }

  /** No document content or access grant is ever exposed on these public asset routes. */
  @Public()
  @Get('plugin/config.json')
  @Header('Cache-Control', 'no-store')
  @Header('Access-Control-Allow-Origin', '*')
  config() {
    return {
      name: 'Mergeron',
      guid: OFFICE_ASSISTANT_GUID,
      version: '1.0.0',
      variations: [
        {
          description: 'Mergeron',
          url: 'index.html',
          icons: ['icon.svg'],
          isViewer: false,
          EditorsSupport: ['word', 'slide'],
          isVisual: true,
          isModal: false,
          isInsideMode: true,
          initDataType: 'none',
          initData: '',
          buttons: [],
          size: [340, 600],
        },
      ],
    };
  }

  @Public()
  @Get('plugin/index.html')
  async html(@Res() reply: FastifyReply) {
    const office = new URL(
      this.settings.getStringSetting(GENERAL_SETTING_KEYS.onlyofficeUrl) ||
        'about:blank',
    );
    if (
      !['https:', 'http:'].includes(office.protocol) ||
      office.username ||
      office.password ||
      office.search ||
      office.hash
    )
      throw new BadRequestException('Invalid editor URL');
    const escape = (value: string) =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;');
    const sdk =
      office.href.replace(/\/+$/, '') + '/sdkjs-plugins/v1/plugins.js';
    return reply
      .type('text/html')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'self' ${office.origin} 'unsafe-eval'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'self' ${office.origin}; base-uri 'none'; form-action 'none'`,
      )
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mergeron</title><link rel="stylesheet" href="plugin.css"><script src="bootstrap.js" data-office-origin="${escape(office.origin)}"></script><script src="${escape(sdk)}"></script><script defer src="plugin.js"></script></head><body><main id="assistant"></main></body></html>`,
      );
  }

  @Public()
  @Get('plugin/bootstrap.js')
  bootstrap(@Res() reply: FastifyReply) {
    return this.asset(
      'bootstrap.js',
      'application/javascript; charset=utf-8',
      reply,
    );
  }
  @Public()
  @Get('plugin/plugin.js')
  js(@Res() reply: FastifyReply) {
    return this.asset(
      'plugin.js',
      'application/javascript; charset=utf-8',
      reply,
    );
  }
  @Public()
  @Get('plugin/plugin.css')
  css(@Res() reply: FastifyReply) {
    return this.asset('plugin.css', 'text/css', reply);
  }
  @Public()
  @Get('plugin/icon.svg')
  icon(@Res() reply: FastifyReply) {
    return this.asset('icon.svg', 'image/svg+xml', reply);
  }

  private async asset(name: string, type: string, reply: FastifyReply) {
    const built = join(process.cwd(), 'public', 'onlyoffice-assistant', name);
    const path = existsSync(built)
      ? built
      : join(process.cwd(), 'web', 'public', 'onlyoffice-assistant', name);
    return reply
      .type(type)
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(await readFile(path));
  }
}
