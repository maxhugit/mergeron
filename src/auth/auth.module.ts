/** Authentication module for API-key fallback, local sessions and OIDC. */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DatabaseModule } from '../database/database.module';
import { IdentityService } from './identity.service';
import { PlatformAccessGuard } from './platform-access.guard';
import { AuthConfigService } from './auth-config.service';
import { LocalAuthService } from './local-auth.service';
import { OidcAuthService } from './oidc-auth.service';
import { InitialAdminController } from './initial-admin.controller';
import { InitialAdminService } from './initial-admin.service';
import {
  ProjectExplorerPreferencesController,
  ProjectExplorerPreferencesService,
} from './project-explorer-preferences';

@Module({
  imports: [JwtModule.register({}), DatabaseModule],
  controllers: [
    AuthController,
    InitialAdminController,
    ProjectExplorerPreferencesController,
  ],
  providers: [
    AuthService,
    InitialAdminService,
    AuthConfigService,
    LocalAuthService,
    OidcAuthService,
    IdentityService,
    PlatformAccessGuard,
    ProjectExplorerPreferencesService,
  ],
  exports: [
    AuthService,
    AuthConfigService,
    LocalAuthService,
    OidcAuthService,
    IdentityService,
    PlatformAccessGuard,
  ],
})
export class AuthModule {}
