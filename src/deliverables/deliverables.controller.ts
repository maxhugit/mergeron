import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import type { FastifyReply } from 'fastify';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { IdentityService } from '../auth/identity.service';
import { ThreadsService } from '../threads/threads.service';
import { ProjectsService } from '../projects/projects.service';
import {
  DeliverablesService,
  type DeliverableInput,
} from './deliverables.service';
@Controller('projects/:projectId/resources/:resourceId/deliverables')
export class DeliverablesController {
  constructor(
    private readonly service: DeliverablesService,
    private readonly identities: IdentityService,
    private readonly threads: ThreadsService,
    private readonly projects: ProjectsService,
  ) {}
  @Post(':id/agent')
  async agent(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Body()
    body: { version: number; subtaskId?: string; subtaskTitle?: string },
    @Req() request: IdentityRequest,
  ) {
    const deliverable = this.service.get(p, r, id);
    const cwd = this.service.agentWorkspace(p, r, id, body.version);
    if (
      (body.subtaskId !== undefined &&
        (typeof body.subtaskId !== 'string' || !body.subtaskId.trim())) ||
      (body.subtaskTitle !== undefined &&
        (typeof body.subtaskTitle !== 'string' || !body.subtaskTitle.trim())) ||
      (body.subtaskId !== undefined && body.subtaskTitle !== undefined)
    )
      throw new BadRequestException(
        'Select one subtask or create one, not both',
      );
    const board = this.service.board(p, r);
    const primaryTask = deliverable.primaryTaskId
      ? board.tasks.find((task) => task.id === deliverable.primaryTaskId)
      : undefined;
    if (
      (body.subtaskId || body.subtaskTitle) &&
      deliverable.primaryTaskId &&
      !primaryTask
    )
      throw new BadRequestException('The primary task no longer exists');
    let createdSubtask = false;
    let subtask:
      | {
          id: string;
          title: string;
          resourceId: string;
          parentTaskId: string | null;
          linkedThreadId?: string | null;
        }
      | undefined = body.subtaskId
      ? board.tasks.find((task) => task.id === body.subtaskId)
      : undefined;
    if (body.subtaskId) {
      if (!primaryTask || !subtask || subtask.parentTaskId !== primaryTask.id)
        throw new BadRequestException(
          'The selected task must be a subtask of the primary task',
        );
      if (subtask.linkedThreadId)
        throw new ConflictException('This subtask already has an agent');
    } else if (body.subtaskTitle !== undefined) {
      const actor = {
        personId: request.platformIdentity?.personId ?? null,
        name: request.platformIdentity?.name ?? 'Système',
      };
      subtask = primaryTask
        ? this.projects.createTask(
            p,
            primaryTask.resourceId,
            {
              parentTaskId: primaryTask.id,
              title:
                typeof body.subtaskTitle === 'string' &&
                body.subtaskTitle.trim()
                  ? body.subtaskTitle.trim()
                  : `Produire — ${deliverable.title}`,
              description: `Produire le livrable « ${deliverable.title} » depuis cette sous-tâche.`,
              validationCriteria: deliverable.criteria,
              executionMode: 'agent',
            },
            actor,
          )
        : this.projects.createDeliverableExecutionSubtask(
            p,
            deliverable.id,
            deliverable.title,
            deliverable.criteria,
            actor,
            typeof body.subtaskTitle === 'string'
              ? body.subtaskTitle
              : undefined,
          );
      createdSubtask = true;
    }
    const started = await this.threads.startThread({ cwd });
    try {
      this.threads.rememberInitialThreadCwd(started.thread.id, cwd);
      this.service.registerAgent(
        p,
        r,
        id,
        body.version,
        started.thread.id,
        subtask?.id,
      );
    } catch (error) {
      await this.threads.archiveThread(started.thread.id).catch(() => {});
      throw error;
    }
    await this.threads
      .setThreadName(started.thread.id, subtask?.title ?? deliverable.title)
      .catch(() => {});
    return {
      threadId: started.thread.id,
      taskId: subtask?.id ?? null,
      createdSubtask,
    };
  }
  @Get() list(@Param('projectId') p: string, @Param('resourceId') r: string) {
    return this.service.board(p, r);
  }
  @Post() create(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Body() body: DeliverableInput,
  ) {
    return this.service.create(p, r, body);
  }
  @Patch(':id') update(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Body() body: DeliverableInput,
  ) {
    return this.service.update(p, r, id, body);
  }
  @Post(':id/lifecycle') transitionLifecycle(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Body() body: Parameters<DeliverablesService['transitionLifecycle']>[3],
  ) {
    return this.service.transitionLifecycle(p, r, id, body);
  }
  @Delete(':id') remove(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Body() body: { version: number },
  ) {
    return this.service.remove(p, r, id, body.version);
  }
  @Get(':id/documents') documents(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
  ) {
    return { documents: this.service.documents(p, r, id) };
  }
  @Post(':id/documents') addDocument(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Body() body: { path?: unknown; comment?: unknown },
    @Req() request: IdentityRequest,
  ) {
    return this.service.addDocumentVersion(p, r, id, body, {
      personId: request.platformIdentity?.personId ?? null,
      name: request.platformIdentity?.name ?? 'Utilisateur',
    });
  }
  @Post(':id/documents/:documentId/versions') addDocumentVersion(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body()
    body: { path?: unknown; comment?: unknown; expectedVersion?: unknown },
    @Req() request: IdentityRequest,
  ) {
    return this.service.addDocumentVersion(
      p,
      r,
      id,
      body,
      {
        personId: request.platformIdentity?.personId ?? null,
        name: request.platformIdentity?.name ?? 'Utilisateur',
      },
      documentId,
    );
  }
  @Delete(':id/documents/:documentId') deleteDocument(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() body: { expectedVersion?: unknown },
  ) {
    return this.service.setDocumentDeleted(
      p,
      r,
      id,
      documentId,
      body.expectedVersion,
      true,
    );
  }
  @Post(':id/documents/:documentId/restore') restoreDeletedDocument(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() body: { expectedVersion?: unknown },
  ) {
    return this.service.setDocumentDeleted(
      p,
      r,
      id,
      documentId,
      body.expectedVersion,
      false,
    );
  }
  @Post(':id/documents/:documentId/versions/:versionId/restore')
  restoreDocumentVersion(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Body() body: { expectedVersion?: unknown; comment?: unknown },
    @Req() request: IdentityRequest,
  ) {
    return this.service.restoreDocumentVersion(
      p,
      r,
      id,
      documentId,
      versionId,
      body,
      {
        personId: request.platformIdentity?.personId ?? null,
        name: request.platformIdentity?.name ?? 'Utilisateur',
      },
    );
  }
  @Get(':id/documents/:documentId/versions/:versionId/file')
  async downloadDocumentVersion(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.service.documentVersionFile(
      p,
      r,
      id,
      documentId,
      versionId,
    );
    return reply
      .type('application/octet-stream')
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.version.fileName)}`,
      )
      .send(createReadStream(file.path));
  }
  @Post(':id/versions') submit(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Body() body: Parameters<DeliverablesService['submit']>[3],
  ) {
    return this.service.submit(p, r, id, body);
  }
  @Post(':id/validations') requestValidation(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Body() body: { version: number },
    @Req() request: IdentityRequest,
  ) {
    return this.service.requestValidation(p, r, id, body, {
      personId: request.platformIdentity?.personId ?? null,
      name: request.platformIdentity?.name ?? 'Utilisateur',
    });
  }
  @Post(':id/validation-requirement') setValidationRequirement(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Body()
    body: Parameters<DeliverablesService['setValidationRequirement']>[3],
    @Req() request: IdentityRequest,
  ) {
    return this.service.setValidationRequirement(p, r, id, body, {
      personId: request.platformIdentity?.personId ?? null,
      name: request.platformIdentity?.name ?? 'Utilisateur',
    });
  }
  @Post(':id/validations/:validationId/cancel') cancelValidation(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('validationId') validationId: string,
    @Body() body: Parameters<DeliverablesService['cancelValidation']>[4],
    @Req() request: IdentityRequest,
  ) {
    return this.service.cancelValidation(p, r, id, validationId, body, {
      personId: request.platformIdentity?.personId ?? null,
      name: request.platformIdentity?.name ?? 'Utilisateur',
    });
  }
  @Post(':id/validations/:validationId/decision') decideValidation(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('validationId') validationId: string,
    @Body() body: Parameters<DeliverablesService['decideValidation']>[4],
    @Req() request: IdentityRequest,
  ) {
    return this.service.decideValidation(p, r, id, validationId, body, {
      personId: request.platformIdentity?.personId ?? null,
      name: request.platformIdentity?.name ?? 'Utilisateur',
    });
  }
  @Post(':id/versions/:versionId/review') review(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: Parameters<DeliverablesService['review']>[4],
    @Req() request: IdentityRequest,
  ) {
    return this.service.review(
      p,
      r,
      id,
      versionId,
      body,
      request.platformIdentity?.name ?? 'Administrateur',
    );
  }
  @Get(':id/versions/:versionId/files/:index') async download(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Param('index') index: string,
    @Res() reply: FastifyReply,
    @Req() request: IdentityRequest,
  ) {
    if (request.platformIdentity?.role !== 'administrator') {
      const source = this.service.versionFiles(p, r, id, versionId)[
        Number(index)
      ];
      this.identities.requireWorkspacePath(
        source?.sourcePath,
        false,
        request.platformIdentity,
      );
    }
    const file = await this.service.file(p, r, id, versionId, Number(index));
    return reply
      .type('application/octet-stream')
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      .send(createReadStream(file.snapshotPath));
  }
}
