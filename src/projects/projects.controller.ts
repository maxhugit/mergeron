import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  ForbiddenException,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import type { IdentityRequest } from '../auth/platform-access.guard';
import type { ProjectActivityActor } from './projects.service';
import type { ActiveFolderContext } from '../active-folders/active-folders.service';
import { requireThreadAccess } from '../auth/access-context';

function activityActor(request: IdentityRequest): ProjectActivityActor {
  return {
    personId: request.platformIdentity?.personId ?? null,
    name: request.platformIdentity?.name ?? 'Système',
  };
}

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get('people')
  people(@Req() request: IdentityRequest) {
    const rows = this.projects.listPeople();
    return {
      people: rows.map(({ identitySubject, ...person }) =>
        request.platformIdentity?.role === 'administrator'
          ? { ...person, identityLinked: !!identitySubject }
          : {
              id: person.id,
              reference: person.reference,
              name: person.name,
              active: person.active,
            },
      ),
    };
  }

  @Post('people')
  createPerson(@Body() body: Parameters<ProjectsService['savePerson']>[0]) {
    return { person: this.projects.savePerson(body) };
  }

  @Patch('people/:personId')
  updatePerson(
    @Param('personId') id: string,
    @Body() body: Parameters<ProjectsService['savePerson']>[0],
  ) {
    return { person: this.projects.savePerson(body, id) };
  }

  @Get(':id/participants')
  participants(@Param('id') id: string, @Req() request: IdentityRequest) {
    const identity = request.platformIdentity;
    if (
      identity?.role !== 'administrator' &&
      (!identity?.personId ||
        !this.projects.isParticipant(id, identity.personId))
    )
      throw new ForbiddenException('Project participant access required');
    return { participants: this.projects.participants(id) };
  }

  @Get(':id/activity')
  activity(@Param('id') id: string) {
    return { activity: this.projects.activity(id) };
  }

  @Put(':id/active-folders/:contextType/:contextId')
  setActiveFolder(
    @Param('id') projectId: string,
    @Param('contextType') contextType: ActiveFolderContext,
    @Param('contextId') contextId: string,
    @Body() body: { resourceId?: unknown; relativePath?: unknown },
  ) {
    if (!['agent', 'simple_chat', 'task', 'deliverable'].includes(contextType))
      throw new BadRequestException('Unsupported active-folder context');
    if (contextType === 'agent') requireThreadAccess(contextId);
    if (contextType === 'simple_chat') requireThreadAccess(contextId, 'simple');
    if (typeof body.resourceId !== 'string')
      throw new BadRequestException('A project resource is required');
    if (
      body.relativePath !== undefined &&
      body.relativePath !== null &&
      typeof body.relativePath !== 'string'
    )
      throw new BadRequestException('Active folder path must be relative');
    return {
      activeFolder: this.projects.setActiveFolder(
        projectId,
        contextType,
        contextId,
        {
          resourceId: body.resourceId,
          relativePath: body.relativePath,
        },
      ),
    };
  }

  @Post(':id/participants')
  addParticipant(
    @Param('id') id: string,
    @Body() body: { personId: string },
    @Req() request: IdentityRequest,
  ) {
    const result = this.projects.addParticipant(id, body.personId);
    const person = this.projects
      .listPeople()
      .find((item) => item.id === body.personId);
    this.projects.recordActivity(
      id,
      'participant_added',
      'participant',
      body.personId,
      person?.name ?? 'Participant',
      {},
      activityActor(request),
    );
    return result;
  }

  @Delete(':id/participants/:personId')
  removeParticipant(
    @Param('id') id: string,
    @Param('personId') personId: string,
    @Req() request: IdentityRequest,
  ) {
    const person = this.projects
      .listPeople()
      .find((item) => item.id === personId);
    const result = this.projects.removeParticipant(id, personId);
    this.projects.recordActivity(
      id,
      'participant_removed',
      'participant',
      personId,
      person?.name ?? 'Participant',
      {},
      activityActor(request),
    );
    return result;
  }

  @Get(':id/people-configuration')
  peopleConfiguration(@Param('id') id: string) {
    return this.projects.peopleConfiguration(id);
  }

  @Put(':id/project-manager')
  configureProjectManager(
    @Param('id') id: string,
    @Body() body: { personId?: unknown },
    @Req() request: IdentityRequest,
  ) {
    return this.projects.configureProjectManager(
      id,
      body.personId ?? null,
      activityActor(request),
    );
  }

  @Post(':id/person-groups')
  createPersonGroup(
    @Param('id') id: string,
    @Body() body: { name?: unknown; memberIds?: unknown },
    @Req() request: IdentityRequest,
  ) {
    return this.projects.savePersonGroup(
      id,
      body,
      undefined,
      activityActor(request),
    );
  }

  @Patch(':id/person-groups/:groupId')
  updatePersonGroup(
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @Body() body: { name?: unknown; memberIds?: unknown },
    @Req() request: IdentityRequest,
  ) {
    return this.projects.savePersonGroup(
      id,
      body,
      groupId,
      activityActor(request),
    );
  }

  @Delete(':id/person-groups/:groupId')
  deletePersonGroup(
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @Req() request: IdentityRequest,
  ) {
    return this.projects.deletePersonGroup(id, groupId, activityActor(request));
  }

  @Get('dashboard')
  dashboard() {
    return this.projects.dashboard();
  }

  @Get()
  async list() {
    return { projects: await this.projects.list() };
  }

  @Post()
  async create(
    @Body() body: { name: string; workspacePath?: string },
    @Req() request: IdentityRequest,
  ) {
    const project = await this.projects.create(body.name, body.workspacePath);
    this.projects.recordActivity(
      project.id,
      'project_created',
      'project',
      project.id,
      project.name,
      { workspacePath: project.workspacePath },
      activityActor(request),
    );
    return { project };
  }

  @Patch(':id')
  rename(
    @Param('id') id: string,
    @Body() body: { name: string },
    @Req() request: IdentityRequest,
  ) {
    const before = this.projects.get(id);
    const project = this.projects.rename(id, body.name);
    this.projects.recordActivity(
      id,
      'project_renamed',
      'project',
      id,
      project.name,
      { before: before.name, after: project.name },
      activityActor(request),
    );
    return { project };
  }

  @Patch(':id/mcp-servers')
  async configureMcpServers(
    @Param('id') id: string,
    @Body() body: { names?: unknown },
    @Req() request: IdentityRequest,
  ) {
    return {
      project: await this.projects.configureMcpServers(
        id,
        body.names,
        activityActor(request),
      ),
    };
  }

  @Patch(':id/apps')
  async configureApps(
    @Param('id') id: string,
    @Body() body: { ids?: unknown },
    @Req() request: IdentityRequest,
  ) {
    return {
      project: await this.projects.configureApps(
        id,
        body.ids,
        activityActor(request),
      ),
    };
  }

  @Patch(':id/browser-settings')
  configureBrowser(
    @Param('id') id: string,
    @Body() body: Parameters<ProjectsService['configureBrowser']>[1],
    @Req() request: IdentityRequest,
  ) {
    return {
      project: this.projects.configureBrowser(id, body, activityActor(request)),
    };
  }

  @Patch(':id/agent-settings')
  configureAgent(
    @Param('id') id: string,
    @Body() body: { model?: unknown; reasoningEffort?: unknown },
    @Req() request: IdentityRequest,
  ) {
    return {
      project: this.projects.configureAgent(id, body, activityActor(request)),
    };
  }

  @Patch(':id/sidebar-order')
  updateSidebarOrder(
    @Param('id') id: string,
    @Body() body: { order?: unknown },
  ) {
    return { project: this.projects.updateSidebarOrder(id, body.order) };
  }

  @Post(':id/workspaces')
  async createWorkspace(
    @Param('id') id: string,
    @Body() body: { name?: string; path?: string },
    @Req() request: IdentityRequest,
  ) {
    const workspace = await this.projects.createWorkspace(id, body);
    this.projects.recordActivity(
      id,
      'workspace_added',
      'workspace',
      workspace.id,
      workspace.name,
      { path: workspace.path },
      activityActor(request),
    );
    return { workspace };
  }

  @Post(':id/resources')
  createResource(
    @Param('id') id: string,
    @Body() body: { type: string; name?: string },
    @Req() request: IdentityRequest,
  ) {
    const resource = this.projects.createResource(id, body);
    this.projects.recordActivity(
      id,
      'resource_created',
      'resource',
      resource.id,
      resource.name,
      { type: resource.type },
      activityActor(request),
    );
    return { resource };
  }

  @Get(':id/resources/:resourceId')
  getResource(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
  ) {
    return this.projects.readResource(id, resourceId);
  }

  @Post(':id/resources/:resourceId/automations')
  createAutomation(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body() body: Parameters<ProjectsService['upsertAutomation']>[2],
  ) {
    return { automation: this.projects.upsertAutomation(id, resourceId, body) };
  }

  @Patch(':id/resources/:resourceId/automations/:automationId')
  updateAutomation(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Param('automationId') automationId: string,
    @Body() body: Parameters<ProjectsService['upsertAutomation']>[2],
  ) {
    return {
      automation: this.projects.upsertAutomation(
        id,
        resourceId,
        body,
        automationId,
      ),
    };
  }

  @Delete(':id/resources/:resourceId/automations/:automationId')
  deleteAutomation(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Param('automationId') automationId: string,
  ) {
    return this.projects.deleteAutomation(id, resourceId, automationId);
  }

  @Post(':id/resources/:resourceId/automations/:automationId/run')
  runAutomation(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Param('automationId') automationId: string,
  ) {
    return this.projects.runAutomation(id, resourceId, automationId);
  }

  @Patch(':id/resources/:resourceId/automation-runs/:runId')
  reviewAutomationRun(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Param('runId') runId: string,
    @Body() body: { decision: 'approved' | 'rejected' },
  ) {
    if (!['approved', 'rejected'].includes(body.decision))
      throw new BadRequestException('Invalid automation decision');
    return this.projects.reviewAutomationRun(
      id,
      resourceId,
      runId,
      body.decision,
    );
  }

  @Post(':id/resources/:resourceId/statuses')
  createTaskStatus(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body() body: { name?: string; color?: string },
  ) {
    return { status: this.projects.createTaskStatus(id, resourceId, body) };
  }

  @Patch(':id/resources/:resourceId/statuses/:statusId')
  updateTaskStatus(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Param('statusId') statusId: string,
    @Body() body: { name?: string; color?: string; position?: number },
  ) {
    return {
      status: this.projects.updateTaskStatus(id, resourceId, statusId, body),
    };
  }

  @Delete(':id/resources/:resourceId/statuses/:statusId')
  deleteTaskStatus(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Param('statusId') statusId: string,
  ) {
    return this.projects.deleteTaskStatus(id, resourceId, statusId);
  }

  @Post(':id/resources/:resourceId/tasks')
  createTask(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body() body: Parameters<ProjectsService['createTask']>[2],
    @Req() request: IdentityRequest,
  ) {
    return {
      task: this.projects.createTask(
        id,
        resourceId,
        body,
        activityActor(request),
      ),
    };
  }

  @Post(':id/resources/:resourceId/ai-plan')
  suggestTasks(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body() body: { prompt?: unknown },
  ) {
    return this.projects.suggestTasks(id, resourceId, body.prompt);
  }

  @Post(':id/resources/:resourceId/ai-replan')
  replanTasks(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body() body: { prompt?: unknown },
  ) {
    return this.projects.replanTasks(id, resourceId, body.prompt);
  }

  @Post(':id/resources/:resourceId/ai-advice')
  taskAdvice(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body() body: { mode?: unknown; availableHours?: unknown },
  ) {
    return this.projects.taskAdvice(
      id,
      resourceId,
      body.mode,
      body.availableHours,
    );
  }

  @Post(':id/resources/:resourceId/tasks/:taskId/ai-subtasks')
  suggestSubtasks(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Param('taskId') taskId: string,
    @Body()
    body: {
      title?: unknown;
      description?: unknown;
      validationCriteria?: unknown;
    },
  ) {
    return this.projects.suggestSubtasks(id, resourceId, taskId, body);
  }

  @Patch(':id/resources/:resourceId/tasks/:taskId')
  async updateTask(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Param('taskId') taskId: string,
    @Body() body: Parameters<ProjectsService['updateTask']>[3],
    @Req() request: IdentityRequest,
  ) {
    return {
      task: await this.projects.updateTask(
        id,
        resourceId,
        taskId,
        body,
        activityActor(request),
      ),
    };
  }

  @Delete(':id/resources/:resourceId/tasks/:taskId')
  async deleteTask(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Param('taskId') taskId: string,
    @Req() request: IdentityRequest,
  ) {
    return await this.projects.deleteTask(
      id,
      resourceId,
      taskId,
      activityActor(request),
    );
  }

  @Patch(':id/resources/:resourceId')
  updateResource(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body()
    body: {
      name?: string;
      config?: Record<string, unknown>;
      labelRenames?: Array<{ from: string; to: string }>;
      removedLabels?: string[];
    },
    @Req() request: IdentityRequest,
  ) {
    const before = this.projects.getResource(id, resourceId);
    const resource = this.projects.updateResource(id, resourceId, body);
    this.projects.recordActivity(
      id,
      'resource_updated',
      'resource',
      resourceId,
      resource.name,
      { beforeName: before.name, afterName: resource.name },
      activityActor(request),
    );
    return {
      resource,
    };
  }

  @Delete(':id/resources/:resourceId')
  deleteResource(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Req() request: IdentityRequest,
  ) {
    const resource = this.projects.getResource(id, resourceId);
    const result = this.projects.deleteResource(id, resourceId);
    this.projects.recordActivity(
      id,
      'resource_deleted',
      'resource',
      resourceId,
      resource.name,
      { type: resource.type },
      activityActor(request),
    );
    return result;
  }

  @Patch(':id/workspaces/:workspaceId/default')
  setDefaultWorkspace(
    @Param('id') id: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: IdentityRequest,
  ) {
    const project = this.projects.get(id);
    const workspace = this.projects.setDefaultWorkspace(id, workspaceId);
    this.projects.recordActivity(
      id,
      'workspace_default_changed',
      'workspace',
      workspace.id,
      workspace.name,
      {
        defaultWorkspace: {
          before: project.workspacePath,
          after: workspace.path,
        },
      },
      activityActor(request),
    );
    return { workspace };
  }

  @Delete(':id/workspaces/:workspaceId')
  detachWorkspace(
    @Param('id') id: string,
    @Param('workspaceId') workspaceId: string,
    @Req() request: IdentityRequest,
  ) {
    const workspace = this.projects.getWorkspace(id, workspaceId);
    const result = this.projects.detachWorkspace(id, workspaceId);
    this.projects.recordActivity(
      id,
      'workspace_detached',
      'workspace',
      workspaceId,
      workspace?.name ?? 'Workspace',
      { path: workspace?.path },
      activityActor(request),
    );
    return result;
  }

  @Post(':id/agents')
  createAgent(
    @Param('id') id: string,
    @Body() body: { workspacePath?: string },
  ) {
    if (typeof body?.workspacePath !== 'string' || !body.workspacePath.trim())
      throw new BadRequestException('Select a project workspace');
    return this.projects.createAgent(id, body.workspacePath);
  }

  @Put(':id/agents/:threadId')
  associateAgent(
    @Param('id') id: string,
    @Param('threadId') threadId: string,
    @Body()
    body: {
      workspacePath?: string;
      locationId?: string;
      resourceId?: string;
      relativePath?: string | null;
      alreadyAtWorkspace?: boolean;
    },
  ) {
    if (
      body.locationId !== undefined &&
      (typeof body.locationId !== 'string' ||
        !body.locationId.trim() ||
        body.resourceId !== undefined ||
        body.workspacePath !== undefined)
    )
      throw new BadRequestException('Choose one explicit project location');
    return this.projects.associateAgent(
      id,
      threadId,
      body.locationId
        ? { locationId: body.locationId, relativePath: body.relativePath }
        : body.resourceId
          ? { resourceId: body.resourceId, relativePath: body.relativePath }
          : (body.workspacePath ?? ''),
      body.alreadyAtWorkspace === true,
    );
  }

  @Post('reconcile-workspaces')
  async reconcileWorkspaces() {
    return this.projects.reconcileMissingWorkspaces();
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Body()
    body: { confirmation: string; deleteWorkspaceIds?: string[] },
  ) {
    return this.projects.remove(
      id,
      body.confirmation,
      Array.isArray(body.deleteWorkspaceIds) ? body.deleteWorkspaceIds : [],
    );
  }
}
