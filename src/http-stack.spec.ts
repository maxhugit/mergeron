import multipart from '@fastify/multipart';
import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { APP_GUARD, HttpAdapterHost } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ServeStaticModule } from '@nestjs/serve-static';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import type { FastifyRequest } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiKeyGuard } from './auth/api-key.guard';
import { AuthService } from './auth/auth.service';
import {
  rejectMissingBuildAsset,
  setStaticHtmlSecurityHeaders,
} from './static-html-security';
import { io } from '../web/node_modules/socket.io-client/build/cjs/index.js';

@UseGuards(ApiKeyGuard)
@WebSocketGateway()
class HttpStackGateway {
  @SubscribeMessage('probe')
  status() {
    return { status: 'ok' };
  }
}

@Controller('probe')
class HttpStackController {
  @Get()
  status() {
    return { status: 'ok' };
  }

  @Post('upload')
  async upload(@Req() request: FastifyRequest) {
    const file = await request.file();
    return {
      filename: file?.filename,
      contents: (await file?.toBuffer())?.toString(),
    };
  }
}

describe('NestJS/Fastify HTTP stack compatibility', () => {
  let app: NestFastifyApplication;
  let root: string;
  const headers = { authorization: 'Bearer test-key' };
  const upload = (contents: string) => ({
    method: 'POST' as const,
    url: '/api/probe/upload',
    headers: {
      ...headers,
      'content-type': 'multipart/form-data; boundary=test',
    },
    payload:
      '--test\r\n' +
      'Content-Disposition: form-data; name="file"; filename="folder/test.txt"\r\n' +
      'Content-Type: text/plain\r\n\r\n' +
      contents +
      '\r\n--test--\r\n',
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'webui-http-stack-'));
    await writeFile(join(root, 'index.html'), '<html>WebUI</html>');
    await writeFile(join(root, 'asset.js'), 'window.webui = true;');
    await writeFile(join(root, 'sw.js'), '// worker');
    const adapter = new FastifyAdapter();
    // ServeStaticModule chooses its loader during provider construction.
    // Tests must expose the adapter before compile(), as NestFactory does.
    const module = await Test.createTestingModule({
      imports: [
        ServeStaticModule.forRoot({
          rootPath: root,
          exclude: ['/api/(.*)'],
          serveStaticOptions: {
            fallthrough: true,
            setHeaders: setStaticHtmlSecurityHeaders,
          },
        }),
      ],
      controllers: [HttpStackController],
      providers: [
        HttpStackGateway,
        {
          provide: AuthService,
          useValue: {
            authenticateToken: (token: string) =>
              Promise.resolve({ ok: token === 'test-key' }),
          },
        },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
      ],
    })
      .overrideProvider(HttpAdapterHost)
      .useValue({ httpAdapter: adapter })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(adapter, {
      logger: false,
    });
    await app.register(multipart, {
      preservePath: true,
      limits: { fileSize: 32 },
    });
    app.setGlobalPrefix('api');
    app
      .getHttpAdapter()
      .getInstance()
      .addHook(
        'onSend',
        async (request, reply, payload) =>
          rejectMissingBuildAsset(request.url, reply, payload) ?? payload,
      );
    app.useWebSocketAdapter(new IoAdapter(app));
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(app, new DocumentBuilder().build()),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(['/', '/index.html', '/login', '/projects/example'])(
    'serves the protected SPA HTML at %s using Fastify replies',
    async (url) => {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('<html>WebUI</html>');
      expect(response.headers['content-security-policy']).toBe(
        "frame-ancestors 'none'",
      );
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cache-control']).toBe('no-store');
      // A request after the HTML callback must still succeed on the same server.
      expect(
        (await app.inject({ url: '/api/probe', headers })).statusCode,
      ).toBe(200);
    },
  );

  it.each([
    '/assets/old-build.js',
    '/assets/old-build.css?version=1',
    '/assets/nested/chunk.js',
  ])('never returns SPA HTML for missing build asset %s', async (url) => {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain('<html>');
  });

  it('revalidates the service worker without altering its MIME type', async () => {
    const response = await app.inject({ url: '/sw.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('javascript');
  });

  it('serves assets and Swagger with the updated static plugin', async () => {
    const asset = await app.inject({ url: '/asset.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('window.webui = true;');
    expect(asset.headers).not.toHaveProperty('content-security-policy');
    expect(asset.headers).not.toHaveProperty('x-frame-options');
    expect(asset.headers).not.toHaveProperty('referrer-policy');
    expect((await app.inject({ url: '/api/docs/' })).statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/docs/swagger-ui-init.js' })).statusCode,
    ).toBe(200);
  });

  it('keeps API routes protected while serving the public SPA', async () => {
    expect((await app.inject({ url: '/api/probe' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/probe',
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401);
    const response = await app.inject({ url: '/api/probe', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers).not.toHaveProperty('content-security-policy');
    expect(response.headers).not.toHaveProperty('x-frame-options');
    expect(response.headers).not.toHaveProperty('referrer-policy');
  });

  it('preserves folder upload paths and file contents', async () => {
    const response = await app.inject(upload('hello'));
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      filename: 'folder/test.txt',
      contents: 'hello',
    });
  });

  it('enforces multipart upload size limits', async () => {
    expect((await app.inject(upload('x'.repeat(33)))).statusCode).toBe(413);
  });

  it.each(['polling', 'websocket'])(
    'exchanges Socket.IO acknowledgements over %s',
    async (transport) => {
      const client = io(await app.getUrl(), {
        transports: [transport],
        auth: { token: 'test-key' },
        reconnection: false,
      });
      try {
        await expect.poll(() => client.connected, { timeout: 3000 }).toBe(true);
        const response: unknown = await client
          .timeout(2000)
          .emitWithAck('probe');
        expect(response).toEqual({ status: 'ok' });
      } finally {
        client.disconnect();
      }
    },
  );
});
