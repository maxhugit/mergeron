import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { WorkspaceResourcesService } from './workspace-resources.service';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { WorkspaceTransfersService } from './workspace-transfers.service';

@Controller('projects/:projectId/workspace-resources')
export class WorkspaceResourcesController {
  constructor(
    private readonly resources: WorkspaceResourcesService,
    private readonly copies: WorkspaceCopiesService,
    private readonly transfers: WorkspaceTransfersService,
  ) {}

  @Get()
  list(@Param('projectId') projectId: string) {
    return {
      resources: this.resources.list(projectId),
      copies: this.copies.list(projectId),
      ...this.transfers.list(projectId),
    };
  }

  @Post('transfers')
  createTransfer(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return { transfer: this.transfers.create(projectId, body) };
  }

  @Delete('transfers/:transferId')
  removeTransfer(
    @Param('projectId') projectId: string,
    @Param('transferId') transferId: string,
  ) {
    return this.transfers.remove(projectId, transferId);
  }

  @Post('transfers/:transferId/preview')
  previewTransfer(
    @Param('projectId') projectId: string,
    @Param('transferId') transferId: string,
  ) {
    return this.transfers.preview(projectId, transferId);
  }

  @Post('transfers/:transferId/runs/:runId/execute')
  executeTransfer(
    @Param('projectId') projectId: string,
    @Param('transferId') transferId: string,
    @Param('runId') runId: string,
  ) {
    return this.transfers.execute(projectId, transferId, runId);
  }

  @Post(':resourceId/copies')
  async createCopy(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
    @Body() body: { name?: unknown; branch?: unknown },
  ) {
    return { copy: await this.copies.create(projectId, resourceId, body) };
  }

  @Delete('copies/:copyId')
  removeCopy(
    @Param('projectId') projectId: string,
    @Param('copyId') copyId: string,
    @Body() body?: { confirmation?: unknown; path?: unknown },
  ) {
    return this.copies.remove(projectId, copyId, body);
  }

  @Post()
  create(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return { resource: this.resources.create(projectId, body) };
  }

  @Patch(':resourceId')
  update(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return { resource: this.resources.update(projectId, resourceId, body) };
  }

  @Post(':resourceId/test')
  async test(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
  ) {
    return { resource: await this.resources.test(projectId, resourceId) };
  }

  @Post(':resourceId/enable')
  enable(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
  ) {
    return { resource: this.resources.setEnabled(projectId, resourceId, true) };
  }

  @Post(':resourceId/disable')
  disable(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
  ) {
    return {
      resource: this.resources.setEnabled(projectId, resourceId, false),
    };
  }

  @Delete(':resourceId')
  detach(
    @Param('projectId') projectId: string,
    @Param('resourceId') resourceId: string,
  ) {
    return this.resources.detach(projectId, resourceId);
  }
}
