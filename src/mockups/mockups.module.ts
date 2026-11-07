import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DeliverablesModule } from '../deliverables/deliverables.module';
import { MockupsService } from './mockups.service';
import { MockupsController } from './mockups.controller';
@Module({
  imports: [DatabaseModule, DeliverablesModule],
  controllers: [MockupsController],
  providers: [
    MockupsService,
    { provide: 'PROJECT_MOCKUP_TOOLS', useExisting: MockupsService },
  ],
})
export class MockupsModule {}
