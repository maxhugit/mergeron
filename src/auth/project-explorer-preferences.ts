import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Req,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { projects, settings } from '../database/schema';
import { IdentityService, type PlatformIdentity } from './identity.service';
import type { IdentityRequest } from './platform-access.guard';

const TABS = ['folders', 'deliverables', 'tasks', 'sources'] as const;
type ExplorerTab = (typeof TABS)[number];
function isTab(value: unknown): value is ExplorerTab {
  return typeof value === 'string' && TABS.includes(value as ExplorerTab);
}

/** Personal presentation, shared by a project's agents; never an access grant. */
@Injectable()
export class ProjectExplorerPreferencesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly identities: IdentityService,
  ) {}

  preference(
    identity: PlatformIdentity | undefined,
    projectId: string,
    change?: { personId?: unknown; tab?: unknown },
  ) {
    if (!identity?.personId || identity.kind !== 'person')
      throw new ForbiddenException('A person is required');
    this.identities.requireActive(identity);
    this.identities.requireProject(identity, projectId);
    if (
      !this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    )
      throw new NotFoundException('Unknown project');
    const category = `project-explorer:${JSON.stringify([identity.personId, projectId])}`;
    const key = `${category}:tab`;
    if (change) {
      if (change.personId !== identity.personId)
        throw new ForbiddenException('Identity changed');
      if (!isTab(change.tab))
        throw new BadRequestException('Invalid explorer tab');
      this.db
        .insert(settings)
        .values({
          key,
          value: JSON.stringify(change.tab),
          category,
          type: 'string',
          description: 'Personal project explorer tab',
          defaultValue: '',
          constraints: '{}',
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: JSON.stringify(change.tab), updatedAt: Date.now() },
        })
        .run();
    }
    const saved = this.db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .get();
    let tab: ExplorerTab = 'folders';
    try {
      const value: unknown = JSON.parse(saved?.value ?? 'null');
      if (isTab(value)) tab = value;
    } catch {
      /* An invalid personal preference cannot prevent project navigation. */
    }
    return { personId: identity.personId, projectId, tab };
  }
}

@Controller('auth/me/project-explorer')
export class ProjectExplorerPreferencesController {
  constructor(
    private readonly preferences: ProjectExplorerPreferencesService,
  ) {}

  @Get(':projectId')
  read(@Param('projectId') projectId: string, @Req() request: IdentityRequest) {
    return this.preferences.preference(request.platformIdentity, projectId);
  }

  @Patch(':projectId')
  save(
    @Param('projectId') projectId: string,
    @Req() request: IdentityRequest,
    @Body() body: { personId?: unknown; tab?: unknown } | null,
  ) {
    if (!body) throw new BadRequestException('Missing explorer preference');
    return this.preferences.preference(
      request.platformIdentity,
      projectId,
      body,
    );
  }
}
