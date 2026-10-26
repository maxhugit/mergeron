import { Controller, Get, Param } from '@nestjs/common';
import { ProjectLocationsService } from './project-locations.service';

/** Additive endpoint; intentionally no normalized mutation routes in phase two. */
@Controller('projects/:projectId/locations')
export class ProjectLocationsController {
  constructor(private readonly locations: ProjectLocationsService) {}

  @Get()
  list(@Param('projectId') projectId: string) {
    return this.locations.list(projectId);
  }
}
