import { AgentProjectMembershipService } from './agent-project-membership.service';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ActiveFoldersService } from './active-folders.service';

@Module({
  imports: [DatabaseModule],
  providers: [ActiveFoldersService, AgentProjectMembershipService],
  exports: [ActiveFoldersService, AgentProjectMembershipService],
})
export class ActiveFoldersModule {}
