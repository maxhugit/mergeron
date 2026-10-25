import { Module } from '@nestjs/common';
import { GitMutationGateService } from './git-mutation-gate.service';
import { ThreadResponseDetailService } from './thread-response-detail.service';
import { ThreadResponseDetailController } from './thread-response-detail.controller';
import { DeliverablesModule } from '../deliverables/deliverables.module';
import { KnowledgeProposalsObserverService } from './knowledge-proposals-observer.service';
import { ProjectKnowledgeModule } from '../project-knowledge/project-knowledge.module';
import { ThreadSecurityPolicyController } from './thread-security-policy.controller';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { CodexModule } from '../codex/codex.module';
import { ConversationBranchesModule } from '../conversation-branches/conversation-branches.module';
import { DatabaseModule } from '../database/database.module';
import { FilesModule } from '../files/files.module';
import { PendingApprovalsModule } from '../pending-approvals/pending-approvals.module';
import { ThreadDeletionModule } from '../thread-deletion/thread-deletion.module';
import { AutoResumeService } from './auto-resume.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';
import { ThreadHistoryService } from './thread-history.service';
import { ThreadCommandsController } from './thread-commands.controller';
import { ThreadCommandsService } from './thread-commands.service';
import { ThreadsBranchingService } from './threads-branching.service';
import { ThreadsController } from './threads.controller';
import { ThreadsDeletePlannerService } from './threads-delete-planner.service';
import { ThreadsDeletionController } from './threads-deletion.controller';
import { ThreadsDeletionService } from './threads-deletion.service';
import { ThreadsGateway } from './threads.gateway';
import { ThreadExecutionInventoryService } from './thread-execution-inventory.service';
import { ThreadMetadataService } from './thread-metadata.service';
import { ThreadsOverviewService } from './threads-overview.service';
import { ThreadsService } from './threads.service';
import { ThreadWorkspaceOverridesService } from './thread-workspace-overrides.service';
import { WorkspacesManagementController } from './workspaces-management.controller';
import { WorkspacesManagementService } from './workspaces-management.service';
import { ProjectConnectionPolicyService } from './project-connection-policy.service';
import { ActiveFoldersModule } from '../active-folders/active-folders.module';

@Module({
  imports: [
    ActiveFoldersModule,
    DeliverablesModule,
    ProjectKnowledgeModule,
    AuthModule,
    ChatModule,
    CodexModule,
    ConversationBranchesModule,
    DatabaseModule,
    FilesModule,
    PendingApprovalsModule,
    ThreadDeletionModule,
  ],
  controllers: [
    ThreadResponseDetailController,
    ThreadsController,
    ThreadsDeletionController,
    ThreadCommandsController,
    ThreadSecurityPolicyController,
    WorkspacesManagementController,
  ],
  providers: [
    GitMutationGateService,
    ThreadResponseDetailService,
    KnowledgeProposalsObserverService,
    ThreadsService,
    ThreadsBranchingService,
    ThreadsDeletePlannerService,
    ThreadsDeletionService,
    ThreadsGateway,
    ThreadHistoryService,
    ThreadResumeRegistryService,
    ThreadSettingsObserverService,
    ThreadCommandsService,
    ThreadsOverviewService,
    ThreadMetadataService,
    ThreadExecutionInventoryService,
    ThreadWorkspaceOverridesService,
    AutoResumeService,
    WorkspacesManagementService,
    ProjectConnectionPolicyService,
  ],
  exports: [
    GitMutationGateService,
    ThreadsService,
    ThreadsBranchingService,
    ThreadsDeletePlannerService,
    ThreadsDeletionService,
    ThreadHistoryService,
    ThreadResumeRegistryService,
    ThreadSettingsObserverService,
    ThreadCommandsService,
    ThreadsOverviewService,
    ThreadMetadataService,
    ThreadExecutionInventoryService,
    ThreadWorkspaceOverridesService,
    WorkspacesManagementService,
  ],
})
export class ThreadsModule {}
