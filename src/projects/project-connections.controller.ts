import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ProjectLocationsService } from './project-locations.service';
import { WorkspaceResourcesService } from './workspace-resources.service';
import { WorkspaceCopiesService } from './workspace-copies.service';

/** Public connection API; historical resources remain a persistence adapter. */
@Controller('projects/:projectId/connections')
export class ProjectConnectionsController {
  constructor(
    private readonly locations: ProjectLocationsService,
    private readonly resources: WorkspaceResourcesService,
    private readonly copies: WorkspaceCopiesService,
  ) {}

  @Get()
  list(@Param('projectId') projectId: string) {
    return { connections: this.locations.list(projectId).connections };
  }

  @Post()
  create(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const resource = this.resources.create(projectId, {
      ...body,
      type: body.protocol ?? body.type,
    });
    return {
      connection: this.locations.connection(projectId, resource.id),
      location: this.locations.location(projectId, `remote:${resource.id}`),
    };
  }

  @Patch(':connectionId')
  update(
    @Param('projectId') projectId: string,
    @Param('connectionId') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    this.locations.connection(projectId, id);
    this.resources.update(projectId, id, body);
    return { connection: this.locations.connection(projectId, id) };
  }

  @Post(':connectionId/test')
  async test(
    @Param('projectId') projectId: string,
    @Param('connectionId') id: string,
  ) {
    this.locations.connection(projectId, id);
    await this.resources.test(projectId, id);
    return { connection: this.locations.connection(projectId, id) };
  }

  @Post(':connectionId/enable')
  enable(
    @Param('projectId') projectId: string,
    @Param('connectionId') id: string,
  ) {
    this.locations.connection(projectId, id);
    this.resources.setEnabled(projectId, id, true);
    return { connection: this.locations.connection(projectId, id) };
  }

  @Post(':connectionId/disable')
  disable(
    @Param('projectId') projectId: string,
    @Param('connectionId') id: string,
  ) {
    this.locations.connection(projectId, id);
    this.resources.setEnabled(projectId, id, false);
    return { connection: this.locations.connection(projectId, id) };
  }

  @Post(':connectionId/copies')
  async createCopy(
    @Param('projectId') projectId: string,
    @Param('connectionId') id: string,
    @Body() body: { name?: unknown; branch?: unknown },
  ) {
    this.locations.connection(projectId, id);
    const copy = await this.copies.create(projectId, id, body);
    return {
      copy: {
        ...copy,
        locationId: this.locations.locationIdForResource(
          projectId,
          copy.localWorkspaceId,
        ),
        sourceConnectionId: id,
      },
    };
  }

  @Delete(':connectionId')
  detach(
    @Param('projectId') projectId: string,
    @Param('connectionId') id: string,
  ) {
    this.locations.connection(projectId, id);
    return this.resources.detach(projectId, id);
  }
}
