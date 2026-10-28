import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  ForbiddenException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { IdentityService } from '../auth/identity.service';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { BrowserService } from './browser.service';
@Controller('browser/:threadId')
export class BrowserController {
  constructor(
    private readonly browser: BrowserService,
    private readonly identities: IdentityService,
  ) {}
  private authorize(
    threadId: string,
    request: IdentityRequest,
    instanceId?: unknown,
  ) {
    if (
      instanceId !== undefined &&
      (typeof instanceId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,64}$/.test(instanceId))
    )
      throw new BadRequestException('Invalid browser instance');
    const identity = request.platformIdentity;
    if (!identity)
      throw new ServiceUnavailableException('Identity unavailable');
    this.identities.requireThread(identity, threadId);
    this.identities.requireAdministrator(identity);
    const owner = identity.personId ?? identity.subject ?? identity.kind;
    return JSON.stringify([
      owner,
      identity.impersonation?.sessionId ?? '',
      threadId,
      instanceId ?? '',
    ]);
  }

  @Post('live')
  async live(
    @Param('threadId') threadId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: IdentityRequest,
    @Res() reply: FastifyReply,
  ) {
    const key = this.authorize(threadId, request, body?.instanceId);
    const abort = new AbortController();
    const close = () => abort.abort();
    reply.raw.on('close', close);
    let started = false;
    const emit = async (event: Record<string, unknown>) => {
      if (abort.signal.aborted || reply.raw.destroyed)
        throw new Error('Viewer disconnected');
      if (!started) {
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store, no-transform',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff',
        });
        started = true;
      }
      if (!reply.raw.write(`data: ${JSON.stringify(event)}\n\n`))
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            clean();
            reject(new Error('Slow viewer'));
          }, 5000);
          const drained = () => {
            clean();
            resolve();
          };
          const ended = () => {
            clean();
            reject(new Error('Viewer disconnected'));
          };
          const clean = () => {
            clearTimeout(timer);
            reply.raw.off('drain', drained);
            reply.raw.off('close', ended);
          };
          reply.raw.once('drain', drained);
          reply.raw.once('close', ended);
        });
    };
    try {
      await this.browser.stream(key, body ?? {}, abort.signal, emit, () =>
        this.authorize(threadId, request, body?.instanceId),
      );
    } catch (error) {
      if (!started) throw error;
      // Never relay browser internals, URLs, CDP errors or credentials.
      if (!reply.raw.destroyed)
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'error', code: error instanceof ForbiddenException || error instanceof UnauthorizedException ? 'BROWSER_ACCESS_DENIED' : 'BROWSER_OPERATION_FAILED' })}\n\n`,
        );
    } finally {
      abort.abort();
      reply.raw.off('close', close);
      if (started && !reply.raw.destroyed) reply.raw.end();
    }
  }
  @Post(':action')
  run(
    @Param('threadId') threadId: string,
    @Param('action') action: string,
    @Body() body: Record<string, unknown>,
    @Req() request: IdentityRequest,
  ) {
    return this.browser.run(
      this.authorize(threadId, request, body?.instanceId),
      action,
      body ?? {},
    );
  }
}
