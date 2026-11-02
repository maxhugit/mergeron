import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  BadRequestException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { PlatformIdentity } from '../auth/identity.service';
import {
  TranscriptionsService,
  MAX_MEDIA_BYTES,
} from './transcriptions.service';
type Request = FastifyRequest & {
  platformIdentity?: PlatformIdentity;
  file(
    options: unknown,
  ): Promise<
    { filename: string; file: Readable & { truncated?: boolean } } | undefined
  >;
};
@Controller('transcriptions')
export class TranscriptionsController {
  constructor(private service: TranscriptionsService) {}
  @Get('status') status(@Req() request: Request) {
    return this.service.status(request.platformIdentity);
  }
  @Get('jobs') list(
    @Req() request: Request,
    @Query('sourceKey') sourceKey: string,
  ) {
    return this.service.list(request.platformIdentity, sourceKey);
  }
  @Get('jobs/:id') get(@Req() request: Request, @Param('id') id: string) {
    return this.service.get(request.platformIdentity, id);
  }
  @Delete('jobs/:id') remove(@Req() request: Request, @Param('id') id: string) {
    return this.service.remove(request.platformIdentity, id);
  }
  @Post('jobs') async create(
    @Req() request: Request,
    @Query('sourceKey') sourceKey: string,
  ) {
    const part = await request.file({
      limits: { files: 1, fileSize: MAX_MEDIA_BYTES, fields: 0 },
    });
    if (!part) throw new BadRequestException('TRANSCRIPTION_FILE_REQUIRED');
    return this.service.create(
      request.platformIdentity,
      part.filename,
      sourceKey,
      part.file,
    );
  }
}
