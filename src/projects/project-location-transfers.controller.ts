import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { ProjectLocationsService } from './project-locations.service';
import { WorkspaceTransfersService } from './workspace-transfers.service';

@Controller('projects/:projectId/location-transfers')
export class ProjectLocationTransfersController {
  constructor(
    private readonly locations: ProjectLocationsService,
    private readonly transfers: WorkspaceTransfersService,
  ) {}

  @Get()
  list(@Param('projectId') projectId: string) {
    const result = this.transfers.list(projectId);
    return {
      ...result,
      transfers: result.transfers.map((transfer) => {
        const { sourceResourceId, destinationWorkspaceId, ...rest } = transfer;
        // Detached rules remain visible and repairable, never silently redirected.
        const id = (resourceId: string) => {
          try {
            return this.locations.locationIdForResource(projectId, resourceId);
          } catch (error) {
            if (error instanceof ConflictException) return null;
            throw error;
          }
        };
        return {
          ...rest,
          sourceLocationId: id(sourceResourceId),
          destinationLocationId: id(destinationWorkspaceId),
        };
      }),
    };
  }

  @Post()
  create(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (
      typeof body.sourceLocationId !== 'string' ||
      typeof body.destinationLocationId !== 'string' ||
      body.sourceResourceId !== undefined ||
      body.destinationWorkspaceId !== undefined
    )
      throw new BadRequestException('Select source and destination locations');
    const transfer = this.transfers.create(projectId, {
      ...body,
      sourceResourceId: this.locations.resourceId(
        projectId,
        body.sourceLocationId,
      ),
      destinationWorkspaceId: this.locations.workspaceId(
        projectId,
        body.destinationLocationId,
      ),
    });
    return {
      transfer: this.list(projectId).transfers.find(
        (item) => item.id === transfer.id,
      ),
    };
  }

  @Delete(':id')
  remove(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.transfers.remove(projectId, id);
  }
  @Post(':id/preview')
  preview(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.transfers.preview(projectId, id);
  }
  @Post(':id/runs/:runId/execute')
  execute(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('runId') runId: string,
  ) {
    return this.transfers.execute(projectId, id, runId);
  }
}
