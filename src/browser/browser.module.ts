import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrowserController } from './browser.controller';
import { BrowserService } from './browser.service';
@Module({
  imports: [AuthModule],
  controllers: [BrowserController],
  providers: [BrowserService],
})
export class BrowserModule {}
