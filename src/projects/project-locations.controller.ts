import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  Query,
  Body,
} from '@nestjs/common';
import { ProjectLocationsService } from './project-locations.service';
import { ActiveFoldersService } from '../active-folders/active-folders.service';
import { FilesService } from '../files/files.service';
import { WorkspaceCopiesService } from './workspace-copies.service';

/** Normalized inventory and scoped local filesystem operations. */
@Controller('projects/:projectId/locations')
export class ProjectLocationsController {
  constructor(
    private readonly locations: ProjectLocationsService,
    private readonly folders: ActiveFoldersService,
    private readonly files: FilesService,
    private readonly copies: WorkspaceCopiesService,
  ) {}

  @Get()
  list(@Param('projectId') projectId: string) {
    return this.locations.list(projectId);
  }

  @Get(':locationId/tree')
  tree(
    @Param('projectId') projectId: string,
    @Param('locationId') locationId: string,
    @Query('relativePath') relativePath: unknown = '',
  ) {
    if (typeof relativePath !== 'string')
      throw new BadRequestException('A relative directory path is required');
    const folder = this.folders.validateLocationSelection(projectId, {
      locationId,
      relativePath,
    });
    if (!folder.effectivePath)
      throw new ConflictException('Location is unavailable');
    return this.files.readDirectory(folder.effectivePath);
  }

  @Delete(':locationId/working-copy')
  removeCopy(
    @Param('projectId') projectId: string,
    @Param('locationId') locationId: string,
    @Body() body?: { confirmation?: unknown; path?: unknown },
  ) {
    const location = this.locations.location(projectId, locationId);
    const copy = this.locations
      .list(projectId)
      .copies.find(
        (item) => item.localWorkspaceId === location.localWorkspaceId,
      );
    if (!copy)
      throw new ConflictException('This location is not a working copy');
    return this.copies.remove(projectId, copy.id, body);
  }
}
