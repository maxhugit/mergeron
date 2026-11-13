import { ProjectAgentLaunchService } from './project-agent-launch.service';
import { CodexModule } from '../codex/codex.module';
import { ProjectTaskRuntimeService } from './project-task-runtime.service';
import { ProjectIntegrityService } from './project-integrity.service';
import { PullRequestTrackerService } from './pull-request-tracker.service';
import { ProjectIntegrityController } from './project-integrity.controller';
import { DocumentOrganizationController } from '../deliverables/document-organization.controller';
import { DocumentLabelsAiAdapter } from './document-labels-ai-adapter.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeliverablesModule } from '../deliverables/deliverables.module';
import { DeliverablesController } from '../deliverables/deliverables.controller';
import { ProjectKnowledgeModule } from '../project-knowledge/project-knowledge.module';
import { ProjectKnowledgeController } from '../project-knowledge/project-knowledge.controller';
import { DatabaseModule } from '../database/database.module';
import { FilesModule } from '../files/files.module';
import { ThreadsModule } from '../threads/threads.module';
import { ProjectAiService } from './project-ai.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ActiveFoldersModule } from '../active-folders/active-folders.module';
import { WorkspaceResourcesController } from './workspace-resources.controller';
import { WorkspaceResourcesService } from './workspace-resources.service';
import { WorkspaceCopiesService } from './workspace-copies.service';
import { WorkspaceTransfersService } from './workspace-transfers.service';
import { ProjectArchivesController } from './project-archives.controller';
import { ProjectArchivesService } from './project-archives.service';
import { WorkspaceGitController } from './workspace-git.controller';
import { WorkspaceGitService } from './workspace-git.service';
import { WorkspaceGitActionsService } from './workspace-git-actions.service';
import { ProjectLocationsController } from './project-locations.controller';
import { ProjectLocationsService } from './project-locations.service';
import { ProjectConnectionsController } from './project-connections.controller';
import { ProjectLocationTransfersController } from './project-location-transfers.controller';
import { ProjectConnectionToolsService } from './project-connection-tools.service';
import { ProjectRemoteToolsService } from './project-remote-tools.service';
import { GitDeliverablesController } from './git-deliverables.controller';
import { GitDeliverablesService } from './git-deliverables.service';

@Module({
  imports: [
    CodexModule,
    ActiveFoldersModule,
    AuthModule,
    DeliverablesModule,
    DatabaseModule,
    FilesModule,
    ThreadsModule,
    ProjectKnowledgeModule,
  ],
  controllers: [
    GitDeliverablesController,
    ProjectIntegrityController,
    DocumentOrganizationController,
    ProjectLocationsController,
    ProjectConnectionsController,
    ProjectLocationTransfersController,
    WorkspaceGitController,
    ProjectArchivesController,
    ProjectsController,
    ProjectKnowledgeController,
    DeliverablesController,
    WorkspaceResourcesController,
  ],
  providers: [
    GitDeliverablesService,
    ProjectTaskRuntimeService,
    ProjectAgentLaunchService,

    ProjectAiService,
    PullRequestTrackerService,
    ProjectIntegrityService,
    DocumentLabelsAiAdapter,
    ProjectConnectionToolsService,
    ProjectRemoteToolsService,
    {
      provide: 'PROJECT_CONNECTION_AGENT_TOOLS',
      useExisting: ProjectConnectionToolsService,
    },
    { provide: 'PROJECT_AGENT_DOMAIN_SERVICE', useExisting: ProjectsService },
    ProjectLocationsService,
    WorkspaceGitActionsService,
    WorkspaceGitService,
    ProjectArchivesService,
    ProjectsService,
    WorkspaceResourcesService,
    WorkspaceCopiesService,
    WorkspaceTransfersService,
  ],
  exports: [
    ProjectsService,
    WorkspaceResourcesService,
    WorkspaceCopiesService,
    WorkspaceTransfersService,
  ],
})
export class ProjectsModule {}
