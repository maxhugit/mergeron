import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccessContextInterceptor } from './auth/access-context.interceptor';
import { ServeStaticModule } from '@nestjs/serve-static';
import { LoggerModule } from 'nestjs-pino';
import { join } from 'node:path';
import { AccountModule } from './account/account.module';
import { AppsModule } from './apps/apps.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ApiKeyGuard } from './auth/api-key.guard';
import { PlatformAccessGuard } from './auth/platform-access.guard';
import { ArchiveModule } from './archive/archive.module';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { CodexModule } from './codex/codex.module';
import { ConversationBranchesModule } from './conversation-branches/conversation-branches.module';
import { DatabaseModule } from './database/database.module';
import { FilesModule } from './files/files.module';
import { LogsModule } from './logs/logs.module';
import { McpServersModule } from './mcp-servers/mcp-servers.module';
import { ModelsModule } from './models/models.module';
import { OnlyOfficeModule } from './onlyoffice/onlyoffice.module';
import { PendingApprovalsModule } from './pending-approvals/pending-approvals.module';
import { PluginsModule } from './plugins/plugins.module';
import { ProjectsModule } from './projects/projects.module';
import { SettingsModule } from './settings/settings.module';
import { SkillsModule } from './skills/skills.module';
import { SimpleChatModule } from './simple-chat/simple-chat.module';
import { TerminalModule } from './terminal/terminal.module';
import { ThreadsModule } from './threads/threads.module';
import { TokenUsageModule } from './token-usage/token-usage.module';
import { TurnDiffModule } from './turn-diff/turn-diff.module';
import { TurnErrorsModule } from './turn-errors/turn-errors.module';

const isDev = process.env.NODE_ENV !== 'production';

const rollTarget = {
  target: 'pino-roll',
  options: {
    file: join(process.cwd(), 'logs', 'app'),
    size: '10m',
    mkdir: true,
    // Closed archives are retained by LogRetentionService across restarts.
  },
};

/** Strips bearer and OIDC response parameters from URLs before logging. */
function sanitizeUrl(url: string): string {
  return url.replace(
    /([?&])(access_token|code|state)=[^&]*/g,
    '$1$2=[Redacted]',
  );
}

const PINO_REDACT = {
  paths: [
    'req.headers["authorization"]',
    'req.headers["cookie"]',
    'req.headers["x-webui-auth-subject"]',
    'req.headers["x-webui-auth-email"]',
    'req.headers["x-authentik-email"]',
    'req.headers["x-authentik-uid"]',
    'req.headers["x-authentik-username"]',
    'req.headers["x-authentik-name"]',
    // File preview URLs may carry RFC 6750 query tokens
    'req.query.access_token',
    'req.query["access_token"]',
    'req.query.code',
    'req.query["code"]',
    'req.query.state',
    'req.query["state"]',
    'res.headers["set-cookie"]',
    'token',
    'accessToken',
    'apiKey',
    'password',
    'passwordHash',
    'clientSecret',
    '*.token',
    '*.accessToken',
    '*.apiKey',
    '*.password',
    '*.passwordHash',
    '*.clientSecret',
  ],
  censor: '[Redacted]',
};

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
        transport: isDev
          ? {
              targets: [
                { ...rollTarget, level: 'trace' },
                {
                  target: 'pino/file',
                  options: { destination: 1 },
                  level: 'trace',
                },
              ],
            }
          : rollTarget,
        redact: PINO_REDACT,
        serializers: {
          req(req: { url?: string; [k: string]: unknown }) {
            // pino-http default serializer fields + sanitized URL
            return {
              id: req.id,
              method: req.method,
              url: typeof req.url === 'string' ? sanitizeUrl(req.url) : req.url,
              query: req.query,
              params: req.params,
              headers: req.headers,
              remoteAddress: req.remoteAddress,
              remotePort: req.remotePort,
            };
          },
        },
      },
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/api/(.*)'],
      serveStaticOptions: {
        fallthrough: true,
      },
    }),
    AuthModule,
    ArchiveModule,
    ChatModule,
    DatabaseModule,
    CodexModule,
    ConversationBranchesModule,
    AccountModule,
    AppsModule,
    FilesModule,
    SettingsModule,
    SkillsModule,
    SimpleChatModule,
    TerminalModule,
    ThreadsModule,
    PendingApprovalsModule,
    TokenUsageModule,
    PluginsModule,
    ProjectsModule,
    OnlyOfficeModule,
    TurnDiffModule,
    TurnErrorsModule,
    ModelsModule,
    LogsModule,
    McpServersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
    { provide: APP_GUARD, useClass: PlatformAccessGuard },
    { provide: APP_INTERCEPTOR, useClass: AccessContextInterceptor },
  ],
})
export class AppModule {}
