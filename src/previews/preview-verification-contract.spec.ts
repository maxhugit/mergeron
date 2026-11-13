import { writeFile } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { expect, it } from 'vitest';
import { PreviewsController } from './previews.controller';
import { ProjectPreviewsService } from './project-previews.service';

it('publishes the typed verification bootstrap contract used by the browser SDK', async () => {
  const module = await Test.createTestingModule({
    controllers: [PreviewsController],
    providers: [{ provide: ProjectPreviewsService, useValue: {} }],
  }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  try {
    app.setGlobalPrefix('api');
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
      {
        operationIdFactory: (controller, method) => {
          const name = controller.replace(/Controller$/, '');
          return `${name.charAt(0).toLowerCase()}${name.slice(1)}_${method}`;
        },
      },
    );
    const url = '/api/projects/{projectId}/agents/{threadId}/preview/verify';
    const operation = document.paths[url].post!;
    expect(operation.operationId).toBe('previews_verify');
    expect(operation.security).toEqual([{ bearer: [] }]);
    expect(operation.parameters?.map((p) => 'name' in p && p.name)).toEqual([
      'projectId',
      'threadId',
    ]);
    expect(operation.responses['201']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/PreviewVerificationOpenDto' },
        },
      },
    });
    expect(
      document.components?.schemas?.PreviewVerificationOpenDto,
    ).toMatchObject({
      required: ['url', 'expiresAt'],
    });
    // Optional local export for focused SDK regeneration without unrelated API changes.
    if (process.env.PREVIEW_OPENAPI_EXPORT)
      await writeFile(
        process.env.PREVIEW_OPENAPI_EXPORT,
        JSON.stringify({ ...document, paths: { [url]: { post: operation } } }),
      );
  } finally {
    await app.close();
  }
});
