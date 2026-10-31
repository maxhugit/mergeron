/**
 * Vitest config for the web client.
 *
 * Merges the Vite build config so tests resolve the `@` alias and run through the
 * same React plugin the app is built with, instead of a second, drifting copy.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';
import { playwright } from '@vitest/browser-playwright';
import type { BrowserCommand } from 'vitest/node';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sessionStackFixtures } from './test/session-stack';

const sessionStack = sessionStackFixtures();
const sessionStackControl: BrowserCommand<
  [
    action:
      | 'create'
      | 'restore'
      | 'dispose'
      | 'status'
      | 'backend'
      | 'auth'
      | 'proxy'
      | 'expired'
      | 'forbidden',
    id?: string,
  ]
> = async (_context, action, id) => sessionStack.control(action, id);

/** Chromium's actual manifest fetch, not a fetch() approximation. */
const authenticatedManifest: BrowserCommand<[]> = async (context) => {
  const browser = context.page.context().browser();
  if (browser?.browserType().name() !== 'chromium') return { skipped: true };
  const page = await context.page.context().newPage();
  try {
    await page.goto(
      new URL('/__pwa_install_fixture__/', context.page.url()).href,
    );
    const session = await page.context().newCDPSession(page);
    const manifest = await session.send('Page.getAppManifest');
    const install = await session.send('Page.getInstallabilityErrors');
    return {
      skipped: false,
      data: manifest.data,
      errors: manifest.errors.map((item) => item.message),
      installErrors: install.installabilityErrors.map((item) => item.errorId),
    };
  } finally {
    await page.close();
  }
};

/** Sends native wheel input inside the test iframe rather than fabricating scroll measurements. */
const scrollTranscript: BrowserCommand<[delta: number]> = async (
  context,
  delta,
) => {
  const bounds = await context.iframe
    .locator('[data-transcript-scroller]')
    .boundingBox();
  if (!bounds) throw new Error('Transcript has no browser layout box');
  await context.page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await context.page.mouse.wheel(0, delta);
};

/** Holds a real pointer gesture so ResizeObserver changes can arrive before pointer release. */
const holdTranscriptPointer: BrowserCommand<[held: boolean]> = async (
  context,
  held,
) => {
  if (!held) {
    await context.page.mouse.up();
    return;
  }
  const bounds = await context.iframe
    .locator('[data-transcript-scroller]')
    .boundingBox();
  if (!bounds) throw new Error('Transcript has no browser layout box');
  await context.page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await context.page.mouse.down();
};

/** Exercises the real divider's pointer capture, preview, release and Escape path. */
const explorerDivider: BrowserCommand<
  [action: 'start' | 'move' | 'end' | 'cancel', delta?: number]
> = async (context, action, delta = 0) => {
  if (action === 'cancel') await context.page.keyboard.press('Escape');
  if (action === 'end' || action === 'cancel') {
    await context.page.mouse.up();
    return;
  }
  const bounds = await context.iframe.getByRole('separator').boundingBox();
  if (!bounds) throw new Error('Explorer divider has no browser layout box');
  await context.page.mouse.move(
    bounds.x + bounds.width / 2 + delta,
    bounds.y + bounds.height / 2,
  );
  if (action === 'start') await context.page.mouse.down();
};

export default mergeConfig(
  viteConfig,
  defineConfig({
    // A desktop task may reuse a read-only dependency installation via a
    // symlink. Permit that exact dependency directory, not the user's home.
    server: {
      fs: {
        allow: [
          fileURLToPath(new URL('.', import.meta.url)),
          realpathSync(new URL('./node_modules', import.meta.url)),
        ],
      },
    },
    plugins: [
      {
        name: 'test-auth-proxy-redirect',
        configureServer(server) {
          server.middlewares.use(sessionStack.middleware);
          server.httpServer?.once('close', () => {
            void sessionStack.dispose();
          });
          // A manifest protected like Authentik: only the document sets the
          // session cookie. Missing crossorigin credentials returns login HTML.
          server.middlewares.use((request, response, next) => {
            const prefix = '/__pwa_install_fixture__/';
            if (!request.url?.startsWith(prefix)) return next();
            const name = request.url.slice(prefix.length).split('?')[0];
            if (!name) {
              const html = readFileSync(
                new URL('./index.html', import.meta.url),
                'utf8',
              );
              const link = html.match(/<link\s+rel="manifest"[^>]*>/)?.[0];
              if (!link) throw new Error('Application manifest link missing');
              response.setHeader(
                'Set-Cookie',
                'mergeron_pwa_fixture=allowed; Path=/__pwa_install_fixture__/; HttpOnly; SameSite=Lax',
              );
              response.setHeader('Content-Type', 'text/html');
              response.end(
                `<html><head>${link.replace('href="/manifest.webmanifest"', 'href="manifest-dev.webmanifest"')}</head><body>PWA fixture</body></html>`,
              );
            } else if (name === 'manifest-dev.webmanifest') {
              if (
                !request.headers.cookie?.includes(
                  'mergeron_pwa_fixture=allowed',
                )
              ) {
                response.statusCode = 302;
                response.setHeader('Location', prefix + 'login');
                return response.end();
              }
              response.setHeader('Content-Type', 'application/manifest+json');
              response.end(
                readFileSync(
                  new URL('./public/manifest-dev.webmanifest', import.meta.url),
                ),
              );
            } else if (
              /^pwa-dev-icon-(192|512|maskable-512)\.png$/.test(name)
            ) {
              response.setHeader('Content-Type', 'image/png');
              response.end(
                readFileSync(new URL('./public/' + name, import.meta.url)),
              );
            } else {
              response.setHeader('Content-Type', 'text/html');
              response.end('<html>Sign in</html>');
            }
          });
          // Real HTTP redirect, including WebKit's opaque manual-redirect response.
          // This endpoint exists only in the test server, never the app build.
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/api/auth/__test_proxy_redirect')
              return next();
            response.statusCode = 302;
            response.setHeader(
              'Location',
              'https://authentication.example.invalid/sign-in',
            );
            response.end();
          });
        },
      },
    ],
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            globals: true,
            environment: 'jsdom',
            setupFiles: ['./src/test/setup.ts'],
            include: ['src/**/*.spec.{ts,tsx}'],
          },
        },
        {
          extends: true,
          test: {
            name: 'browser',
            include: ['src/**/*.browser.{ts,tsx}'],
            // Failure annotations copy screenshots too; keep those copies
            // under the same ignored and per-run-cleared directory.
            attachmentsDir: '.vitest-screenshots/attachments',
            browser: {
              enabled: true,
              headless: true,
              provider: playwright(),
              commands: {
                authenticatedManifest,
                scrollTranscript,
                holdTranscriptPointer,
                explorerDivider,
                sessionStackControl,
              },
              // Failure screenshots default to a `__screenshots__` folder beside
              // each test file, which scatters build output through `src/` and
              // only ever grows: every failing case writes one per run, and
              // renaming a case orphans its file rather than replacing it.
              // Collected in one ignored directory that `test:browser` clears.
              screenshotDirectory: '.vitest-screenshots',
              instances: [{ browser: 'chromium' }, { browser: 'webkit' }],
            },
          },
        },
      ],
    },
  }),
);
