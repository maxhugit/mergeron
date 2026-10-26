import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import type { IdentityRequest } from '../auth/platform-access.guard';
import {
  PROJECT_ARCHIVE_MAX_BYTES,
  ProjectArchivesService,
} from './project-archives.service';

export function archiveAdministrator(request: IdentityRequest) {
  const identity = request.platformIdentity;
  if (!identity?.active || identity.role !== 'administrator')
    throw new ForbiddenException(
      'Cette opération est réservée aux administrateurs.',
    );
  return {
    personId: identity.personId,
    owner: identity.personId ?? identity.subject ?? identity.kind,
  };
}

@Controller('project-archives')
export class ProjectArchivesController {
  constructor(private readonly archives: ProjectArchivesService) {}

  @Get(':projectId/export')
  async export(
    @Param('projectId') projectId: string,
    @Req() request: IdentityRequest,
    @Res() reply: FastifyReply,
  ) {
    archiveAdministrator(request);
    const result = await this.archives.exportProject(projectId);
    const stream = createReadStream(result.file);
    stream.once('close', () => void result.dispose());
    reply.raw.once('close', () => stream.destroy());
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Disposition',
      'attachment; filename="mergeron-project.zip"',
    );
    return reply.type('application/zip').send(stream);
  }

  @Post('preview')
  async preview(@Req() request: FastifyRequest & IdentityRequest) {
    const { owner } = archiveAdministrator(request);
    const upload = await request.file({
      limits: { files: 1, fields: 0, fileSize: PROJECT_ARCHIVE_MAX_BYTES },
    });
    if (!upload)
      throw new BadRequestException('Sélectionnez un ZIP de projet.');
    return this.archives.preview(owner, upload.file);
  }

  @Delete('preview/:token')
  discard(@Param('token') token: string, @Req() request: IdentityRequest) {
    return this.archives.discard(archiveAdministrator(request).owner, token);
  }

  @Post('import')
  async import(
    @Req() request: IdentityRequest,
    @Body()
    body: {
      token?: unknown;
      name?: unknown;
      selection?: unknown;
      personMappings?: unknown;
    },
  ) {
    const { owner, personId } = archiveAdministrator(request);
    return this.archives.importProject(owner, personId, body ?? {});
  }
}
