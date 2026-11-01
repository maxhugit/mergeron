import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { normalizeForwardedPrefix, renderIndexHtml } from './public-base-path';
import { FILES_SETTING_KEYS } from './settings/settings.definitions';
import { SettingsService } from './settings/settings.service';
import { isPreviewHost, isPreviewOrigin } from './previews/preview-origin';
import { rejectMissingBuildAsset } from './static-html-security';

/** Keeps generated SDK operation names stable across controller renames. */
function operationIdFactory(controllerKey: string, methodKey: string): string {
  const controller = controllerKey.replace(/Controller$/, '');
  return `${controller.charAt(0).toLowerCase()}${controller.slice(1)}_${methodKey}`;
}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (request, reply) => {
      if (
        process.env.MERGERON_PREVIEWS_ENABLED === 'true' &&
        isPreviewOrigin(
          request.headers.origin,
          process.env.MERGERON_PREVIEW_DOMAIN,
        )
      ) {
        await reply
          .code(403)
          .send('Preview origins cannot access the Mergeron application.');
        return;
      }
      if (
        isPreviewHost(request.headers.host, process.env.MERGERON_PREVIEW_DOMAIN)
      )
        await reply
          .code(421)
          .send('Preview hosts must use the isolated preview gateway.');
    });

  // A full catalog carries every model's instruction text, and JSON string
  // escaping inflates it further, so those routes need far more than Fastify's
  // 1 MiB default. config.toml does not: it stays near the default so a raw
  // config save cannot be used to push an oversized body.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url.startsWith('/api/codex/catalog')) {
        route.bodyLimit = 18 * 1024 * 1024;
      } else if (route.url === '/api/codex/config/raw') {
        route.bodyLimit = 2 * 1024 * 1024;
      }
    });

  const settingsService = app.get(SettingsService);
  const uploadMaxBytes = settingsService.getNumberSetting(
    FILES_SETTING_KEYS.uploadMaxBytes,
  );

  await app.register(multipart, {
    // Folder uploads send webkitRelativePath as the multipart filename.
    // Keep that relative path so FilesService can validate and recreate it.
    preservePath: true,
    limits: {
      fileSize: uploadMaxBytes,
    },
  });

  const logger = app.get(Logger);
  app.useLogger(logger);
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useWebSocketAdapter(new IoAdapter(app));
  app.setGlobalPrefix('api', { exclude: ['/'] });

  // `public/` is a gitignored build artifact, so it is absent on a fresh clone
  // and during any backend-only dev loop. A missing SPA must not stop the
  // server: there is simply no HTML to rewrite.
  const indexHtml = await readFile(
    join(__dirname, '..', 'public', 'index.html'),
    'utf8',
  ).catch(() => null);

  if (indexHtml === null) {
    logger.warn(
      'public/index.html not found — serving API only. Run `cd web && pnpm build` to build the SPA.',
    );
  } else {
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onSend', async (request, reply, payload) => {
        const contentType = String(reply.getHeader('content-type') ?? '');
        // The SPA fallback must never masquerade as a removed build asset.
        // This also covers files requested by an old tab after deployment.
        const missingAsset = rejectMissingBuildAsset(
          request.url,
          reply,
          payload,
        );
        if (missingAsset !== undefined) return missingAsset;
        if (
          request.method !== 'GET' ||
          request.url.startsWith('/api') ||
          !contentType.startsWith('text/html')
        ) {
          return payload;
        }

        if (payload instanceof Readable) payload.destroy();
        reply.removeHeader('content-length');
        reply.header('Cache-Control', 'no-store');
        const basePath = normalizeForwardedPrefix(
          request.headers['x-forwarded-prefix'],
        );
        return renderIndexHtml(
          indexHtml,
          basePath,
          process.env.MERGERON_STACK_ENVIRONMENT ?? process.env.NODE_ENV,
        );
      });
  }

  if (process.env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Mergeron')
      .setDescription('Mergeron API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig, {
      operationIdFactory,
    });
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(process.env.PORT ?? 8172, '0.0.0.0');
}
void bootstrap();
