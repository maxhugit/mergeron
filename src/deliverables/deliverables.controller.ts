import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  Query,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import type { FastifyReply } from 'fastify';
import type { FileUploadInput } from '../files/files.service';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { IdentityService } from '../auth/identity.service';
import {
  ProjectAgentLaunchService,
  type DeliverableAgentInput,
} from '../projects/project-agent-launch.service';
import { ThreadMetadataService } from '../threads/thread-metadata.service';
import { GitMutationGateService } from '../threads/git-mutation-gate.service';
import {
  requireExecutionAccess,
  requireThreadAccess,
} from '../auth/access-context';
import {
  DeliverablesService,
  type DeliverableInput,
} from './deliverables.service';
@Controller('projects/:projectId/resources/:resourceId/deliverables')
export class DeliverablesController {
  constructor(
    private readonly service: DeliverablesService,
    private readonly identities: IdentityService,
    private readonly metadata: ThreadMetadataService,
    private readonly mutations: GitMutationGateService,
    private readonly launches: ProjectAgentLaunchService,
  ) {}
  @Post('link-task')
  linkTask(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Body() body: Parameters<DeliverablesService['linkPrimaryTask']>[2],
  ) {
    return this.service.linkPrimaryTask(p, r, body);
  }

  @Post(':id/documents/upload')
  uploadDocuments(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Query('documentId') documentId: string | undefined,
    @Query('expectedVersion') expectedVersion: string | undefined,
    @Query('comment') comment: string | undefined,
    @Req()
    request: {
      files: () => AsyncIterable<{
        filename: string;
        file: FileUploadInput['stream'];
      }>;
    },
  ) {
    async function* uploads(): AsyncIterable<FileUploadInput> {
      for await (const file of request.files())
        yield { filename: file.filename, stream: file.file };
    }
    return this.service.uploadDocuments(p, r, id, uploads(), {
      documentId,
      expectedVersion:
        expectedVersion === undefined ? undefined : Number(expectedVersion),
      comment,
    });
  }

  @Get(':id/available-agents')
  async availableAgents(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
  ) {
    const ids = new Set(this.service.availableAgentIds(p, r, id));
    const { entries } = await this.metadata.read();
    const item = this.service.get(p, r, id);
    const cwd = this.service.agentWorkspace(p, r, id, item.version);
    return {
      agents: entries
        .filter(
          ({ thread, archived }) =>
            ids.has(thread.id) &&
            thread.cwd === cwd &&
            !archived &&
            (thread.status.type === 'idle' ||
              thread.status.type === 'notLoaded'),
        )
        .map(({ thread }) => ({
          id: thread.id,
          title: thread.name || thread.preview || thread.id,
        })),
    };
  }
  @Post(':id/assignment')
  assignExistingAgent(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Body() body: { threadId: string; version: number },
  ) {
    requireExecutionAccess();
    if (
      !body ||
      typeof body.threadId !== 'string' ||
      !body.threadId.trim() ||
      body.threadId.length > 100 ||
      !Number.isSafeInteger(body.version) ||
      body.version < 1
    )
      throw new BadRequestException('Invalid agent assignment');
    requireThreadAccess(body.threadId);
    return this.mutations.mutate(() => {
      const item = this.service.get(p, r, id);
      if (
        !item.conversations.some(
          (link) => link.type === 'agent' && link.id === body.threadId,
        )
      )
        this.service.registerAgent(
          p,
          r,
          id,
          body.version,
          body.threadId,
          undefined,
          true,
        );
      return Promise.resolve(this.service.get(p, r, id));
    });
  }

  @Post(':id/agent')
  agent(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Body() body: DeliverableAgentInput,
  ) {
    requireExecutionAccess();
    if (body.existingThreadId !== undefined)
      return this.mutations.mutate(() =>
        this.launches.deliverable(p, r, id, body),
      );
    return this.launches.deliverable(p, r, id, body);
  }
  @Get(':id/agent-launch')
  agentLaunchStatus(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
  ) {
    return this.launches.status(p, r, 'deliverable', id);
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
  @Patch(':id/documents/:documentId') renameDocument(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() body: Parameters<DeliverablesService['renameDocument']>[4],
  ) {
    return this.service.renameDocument(p, r, id, documentId, body);
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
