import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { currentAccess } from '../auth/access-context';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { projectAgentThreads } from '../database/schema';
import { AgentMonitorStore } from './agent-monitor-store';
import { AgentMonitorRuntime } from './agent-monitor-runtime.service';
import { MONITOR_LIMITS } from './agent-monitor-types';
import {
  createMonitorInput,
  manageMonitorInput,
  readMonitorInput,
  reportMonitorInput,
} from './agent-monitor-schema';

@Injectable()
export class AgentMonitorsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly identities: IdentityService,
    readonly store: AgentMonitorStore,
    private readonly runtime: AgentMonitorRuntime,
  ) {}

  private actor(identity: PlatformIdentity, projectId: string) {
    if (!identity)
      throw new ForbiddenException('MONITOR_PERSONAL_ADMINISTRATOR_REQUIRED');
    const actor = this.identities.current(identity);
    this.identities.requireAdministrator(actor);
    this.identities.requireProject(actor, projectId);
    if (actor.kind !== 'person' || !actor.personId || actor.impersonation)
      throw new ForbiddenException('MONITOR_PERSONAL_ADMINISTRATOR_REQUIRED');
    return actor;
  }

  list(identity: PlatformIdentity, projectId: string) {
    this.actor(identity, projectId);
    return {
      monitors: this.store.list(projectId),
      limits: MONITOR_LIMITS,
      activeRuns: this.store
        .active()
        .filter(
          (run) => this.store.monitorForRun(run.id)?.projectId === projectId,
        ),
    };
  }

  read(identity: PlatformIdentity, projectId: string, id: string) {
    this.actor(identity, projectId);
    return {
      monitor: this.store.get(projectId, id),
      runs: this.store.history(projectId, id),
    };
  }

  create(identity: PlatformIdentity, projectId: string, value: unknown) {
    const actor = this.actor(identity, projectId);
    const parsed = createMonitorInput.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException('MONITOR_INVALID_REQUEST');
    const { threadId, ...input } = parsed.data;
    this.identities.requireThread(actor, threadId);
    return {
      monitor: this.store.create(projectId, threadId, actor.personId!, input),
    };
  }

  pause(identity: PlatformIdentity, projectId: string, id: string) {
    this.actor(identity, projectId);
    return { monitor: this.store.setPaused(projectId, id, true) };
  }

  async resume(identity: PlatformIdentity, projectId: string, id: string) {
    this.actor(identity, projectId);
    const item = this.store.get(projectId, id);
    this.runtime.authorize(item);
    await this.runtime.verifyIdleForResume(item);
    // The originating HTTP identity can be revoked while native state is read.
    this.actor(identity, projectId);
    return { monitor: this.store.setPaused(projectId, id, false) };
  }

  stop(identity: PlatformIdentity, projectId: string, id: string) {
    this.actor(identity, projectId);
    return { monitor: this.store.stop(projectId, id) };
  }

  remove(identity: PlatformIdentity, projectId: string, id: string) {
    this.actor(identity, projectId);
    this.store.remove(projectId, id);
    return { deleted: true };
  }

  /** MCP scope and turnId are server supplied, never accepted from arguments. */
  tool(
    projectId: string,
    threadId: string,
    turnId: string,
    input: Record<string, unknown>,
    assertActive: () => void,
    canWrite = false,
  ) {
    assertActive();
    const access = currentAccess();
    if (!access || !turnId)
      throw new ForbiddenException('MONITOR_AUTHENTICATED_TURN_REQUIRED');
    const actor = this.actor(access.identity, projectId);
    this.identities.requireThread(actor, threadId);
    if (
      !this.db
        .select()
        .from(projectAgentThreads)
        .where(
          and(
            eq(projectAgentThreads.projectId, projectId),
            eq(projectAgentThreads.threadId, threadId),
          ),
        )
        .get()
    )
      throw new ForbiddenException('MONITOR_PROJECT_CHANGED');
    const { tool, ...args } = input;
    const owned = (id: string) => {
      const item = this.store.get(projectId, id);
      if (item.threadId !== threadId || item.personId !== actor.personId)
        throw new ForbiddenException('MONITOR_NOT_OWNED');
      return item;
    };
    const current = this.store
      .active()
      .find((run) => run.activeThreadId === threadId);
    if (tool === 'agent_monitor_read') {
      const parsed = readMonitorInput.safeParse(args);
      if (!parsed.success)
        throw new BadRequestException('MONITOR_INVALID_REQUEST');
      if (parsed.data.operation === 'history') {
        owned(parsed.data.monitorId);
        return { runs: this.store.history(projectId, parsed.data.monitorId) };
      }
      return parsed.data.operation === 'current'
        ? { run: current?.turnId === turnId ? current : null }
        : {
            monitors: this.store
              .list(projectId)
              .filter(
                (item) =>
                  item.threadId === threadId &&
                  item.personId === actor.personId,
              ),
            limits: MONITOR_LIMITS,
          };
    }
    if (tool === 'agent_monitor_report') {
      const parsed = reportMonitorInput.safeParse(args);
      if (!parsed.success)
        throw new BadRequestException('MONITOR_INVALID_REQUEST');
      if (!current || current.turnId !== turnId || current.status !== 'running')
        throw new ForbiddenException('MONITOR_NO_OWNED_CHECK');
      owned(current.monitorId);
      assertActive();
      return {
        run: this.store.report(
          current.id,
          turnId,
          parsed.data.summary,
          parsed.data.disposition,
        ),
      };
    }
    const parsed = manageMonitorInput.safeParse(args);
    if (tool !== 'agent_monitor_manage' || !parsed.success)
      throw new BadRequestException('MONITOR_INVALID_REQUEST');
    // An unattended check may report its outcome, not clone itself or raise its budget.
    if (current)
      throw new ForbiddenException('MONITOR_RECURSIVE_SCHEDULING_DENIED');
    assertActive();
    if (parsed.data.operation === 'create') {
      const { operation, userRequest, ...definition } = parsed.data;
      void operation;
      void userRequest;
      const observed = this.runtime.accessForSchedule(threadId);
      assertActive();
      return {
        monitor: this.store.create(
          projectId,
          threadId,
          actor.personId!,
          {
            ...definition,
            accessMode:
              canWrite && observed === 'workspaceWrite'
                ? 'workspaceWrite'
                : 'readOnly',
          },
          Date.now(),
          { agentScheduled: true },
        ),
      };
    }
    owned(parsed.data.monitorId);
    return {
      monitor:
        parsed.data.operation === 'pause'
          ? this.store.setPaused(projectId, parsed.data.monitorId, true)
          : this.store.stop(projectId, parsed.data.monitorId),
    };
  }
}
