/** Read-only, identity-filtered status projection. Never starts an optional service. */
import { Controller, Get, Inject, Req } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { canReadProject, canReadThread } from '../auth/access-context';
import type { IdentityRequest } from '../auth/platform-access.guard';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { agentPreviews, transcriptionJobs } from '../database/schema';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ServerReleaseService } from '../settings/server-release.service';
import { ThreadMetadataService } from './thread-metadata.service';

@Controller('activity')
export class ActivityController {
  constructor(
    private readonly metadata: ThreadMetadataService,
    private readonly pending: PendingApprovalsService,
    private readonly releases: ServerReleaseService,
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
  ) {}

  @Get()
  async read(@Req() request: IdentityRequest) {
    // Failed metadata must not prevent reading independent operations/build info.
    const snapshot = await this.metadata.read().catch(() => null);
    const visible = (snapshot?.entries ?? []).filter(
      ({ thread, archived }) =>
        !archived &&
        canReadThread(thread.id) &&
        (!thread.forkedFromId || canReadThread(thread.forkedFromId)),
    );
    const waitingIds = new Set(
      this.pending
        .listPending(visible.map(({ thread }) => thread.id))
        .map((item) => item.threadId),
    );
    const agents = visible.flatMap(({ thread }) => {
      const flags =
        thread.status.type === 'active' ? thread.status.activeFlags : [];
      const waiting =
        waitingIds.has(thread.id) ||
        flags?.some(
          (flag) =>
            flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
        );
      if (!waiting && thread.status.type !== 'active') return [];
      return [
        {
          threadId: thread.id,
          name: thread.name || thread.id,
          state: waiting ? ('waiting' as const) : ('running' as const),
        },
      ];
    });
    agents.sort(
      (a, b) =>
        Number(b.state === 'waiting') - Number(a.state === 'waiting') ||
        a.threadId.localeCompare(b.threadId),
    );
    const identity = request.platformIdentity;
    const owner =
      identity?.kind === 'person' && identity.personId
        ? identity.personId +
          (identity.impersonation ? ':' + identity.impersonation.sessionId : '')
        : null;
    const media = owner
      ? this.db
          .select({
            id: transcriptionJobs.id,
            threadId: transcriptionJobs.threadId,
            projectId: transcriptionJobs.projectId,
            state: transcriptionJobs.state,
          })
          .from(transcriptionJobs)
          .where(
            and(
              eq(transcriptionJobs.owner, owner),
              inArray(transcriptionJobs.state, [
                'queued',
                'uploading',
                'preparing',
                'decoding',
                'extracting',
                'loading',
                'transcribing',
                'diarizing',
              ]),
            ),
          )
          .all()
          .filter(
            (job) =>
              (!job.projectId || canReadProject(job.projectId)) &&
              (!job.threadId || canReadThread(job.threadId)),
          )
      : [];
    const previews = this.db
      .select({
        id: agentPreviews.previewId,
        threadId: agentPreviews.threadId,
        projectId: agentPreviews.projectId,
        state: agentPreviews.state,
      })
      .from(agentPreviews)
      .where(inArray(agentPreviews.state, ['preparing', 'starting']))
      .all()
      .filter(
        (job) => canReadProject(job.projectId) && canReadThread(job.threadId),
      );
    const operations = [
      ...media.map((job) => ({
        id: job.id,
        threadId: job.threadId,
        kind: 'media' as const,
      })),
      ...previews.map((job) => ({
        id: job.id,
        threadId: job.threadId,
        kind: 'preview' as const,
      })),
    ];
    const build = await this.releases.installedBuild();
    return {
      agents: {
        running: agents.filter((a) => a.state === 'running').length,
        waiting: agents.filter((a) => a.state === 'waiting').length,
        items: agents.slice(0, 30),
        total: agents.length,
        stale: !snapshot || snapshot.freshness.stale,
        refreshedAt: snapshot?.freshness.refreshedAt ?? null,
      },
      operations: { total: operations.length, items: operations.slice(0, 30) },
      installation: {
        version: build.version,
        channel: build.channel,
        environment:
          process.env.MERGERON_STACK_ENVIRONMENT === 'development'
            ? 'development'
            : process.env.MERGERON_STACK_ENVIRONMENT === 'production'
              ? 'production'
              : 'unknown',
      },
    };
  }
}
