import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Header,
} from '@nestjs/common';
import { archiveAdministrator } from './project-archives.controller';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { ProjectIntegrityService } from './project-integrity.service';

@Controller('project-integrity')
export class ProjectIntegrityController {
  constructor(private readonly integrity: ProjectIntegrityService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Req() request: IdentityRequest) {
    archiveAdministrator(request);
    return { projects: this.integrity.list() };
  }
  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  inspect(@Param('id') id: string, @Req() request: IdentityRequest) {
    archiveAdministrator(request);
    return this.integrity.inspect(id);
  }
  @Post(':id/repair')
  @Header('Cache-Control', 'private, no-store')
  repair(
    @Param('id') id: string,
    @Req() request: IdentityRequest,
    @Body() body: Parameters<ProjectIntegrityService['repair']>[1],
  ) {
    archiveAdministrator(request);
    return this.integrity.repair(id, body, {
      personId: request.platformIdentity!.personId ?? null,
      name: request.platformIdentity!.name ?? 'Administrateur',
    });
  }
}
