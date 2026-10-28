import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrowserController } from './browser.controller';
import { BrowserService } from './browser.service';
import { LocalBrowserService } from './local-browser.service';
import { LocalBrowserController } from './local-browser.controller';
@Module({
  imports: [AuthModule],
  controllers: [BrowserController, LocalBrowserController],
  providers: [BrowserService, LocalBrowserService],
  exports: [LocalBrowserService],
})
export class BrowserModule {}
