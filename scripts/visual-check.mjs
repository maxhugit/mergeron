import { chromium, devices } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const help = `Usage: mergeron-visual-check --smoke [--output <directory>]
       mergeron-visual-check --url <http(s) URL> --selector <CSS selector>
         [--text <expected text>] [--start <server command>] [--cwd <directory>]
         [--timeout <milliseconds>] [--output <directory>]

Runs sandboxed headless Chromium. Saves desktop.png, mobile.png and report.json.
--start launches a trusted shell command, waits for the URL and stops it on exit.
Use only on your own/trusted sites; use the isolated Browser for untrusted sites.
`;

export function optionsFrom(args) {
  const options = {
    output: 'artifacts/visual-check',
    cwd: process.cwd(),
    timeout: 60_000,
  };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--help' || name === '-h') return { help: true };
    if (name === '--smoke') {
      options.smoke = true;
      continue;
    }
    const key = {
      '--url': 'url',
      '--selector': 'selector',
      '--text': 'text',
      '--start': 'start',
      '--cwd': 'cwd',
      '--output': 'output',
      '--timeout': 'timeout',
    }[name];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error(`Invalid option: ${name}`);
    options[key] = args[++i];
  }
  options.timeout = Number(options.timeout);
  if (
    !Number.isInteger(options.timeout) ||
    options.timeout < 1 ||
    options.timeout > 600_000
  )
    throw new Error('Timeout must be between 1 and 600000 ms');
  if (options.smoke) {
    if (options.url || options.start)
      throw new Error('--smoke cannot be combined with --url or --start');
    options.selector = '#ready';
    options.text = 'Visual verification ready';
  } else {
    if (!options.url || !options.selector)
      throw new Error('--url and --selector are required');
    const url = new URL(options.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('Use an HTTP(S) URL without embedded credentials');
  }
  options.cwd = resolve(options.cwd);
  options.output = resolve(options.cwd, options.output);
  return options;
}

export function safeUrl(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

export function proxyFrom(env) {
  const address =
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!address) return undefined;
  const url = new URL(address);
  const proxy = {
    server: `${url.protocol}//${url.host}`,
    bypass: env.NO_PROXY || env.no_proxy || '127.0.0.1,localhost',
  };
  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  return proxy;
}

export async function waitForUrl(request, url, timeout, child) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null)
      throw new Error(
        `Site server exited with code ${child.exitCode}; inspect server.log`,
      );
    try {
      const response = await request.get(url, {
        timeout: Math.min(2_000, deadline - Date.now()),
      });
      const status = response.status();
      const ready = status >= 200 && status < 400;
      await response.dispose();
      if (ready) return;
    } catch {
      /* DNS, TLS and connection failures never count as ready. */
    }
    await delay(150);
  }
  throw new Error(
    `Site did not become ready within ${timeout} ms: ${safeUrl(url)}`,
  );
}

async function stopServer(child) {
  if (!child?.pid) return;
  const signal = (name) => {
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  // The shell can exit before its descendants: always clean up the whole group.
  await delay(500);
  signal('SIGKILL');
}

export async function run(options) {
  await mkdir(options.output, { recursive: true, mode: 0o700 });
  // A failed rerun must never leave a previous success report behind.
  await writeFile(
    resolve(options.output, 'report.json'),
    `${JSON.stringify({ success: false, status: 'running' })}\n`,
    { mode: 0o600 },
  );
  let fixture, child, browser, serverLog;
  const interruption = () => {
    void stopServer(child).finally(() => process.exit(130));
  };
  process.once('SIGINT', interruption);
  process.once('SIGTERM', interruption);
  try {
    if (options.smoke) {
      fixture = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(
          '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Visual smoke</title><style>body{font:20px sans-serif;margin:32px;background:#eef4fa;color:#16324f}main{max-width:800px;padding:24px;background:white;border-radius:16px} @media(max-width:500px){body{margin:12px}main{padding:16px}}</style><main><h1 id="ready">Visual verification ready</h1><p>Local HTML · Chromium · desktop and mobile</p></main></html>',
        );
      });
      await new Promise((done, reject) => {
        fixture.once('error', reject);
        fixture.listen(0, '127.0.0.1', done);
      });
      options.url = `http://127.0.0.1:${fixture.address().port}`;
    }
    if (options.start) {
      serverLog = await open(resolve(options.output, 'server.log'), 'w', 0o600);
      child = spawn(options.start, {
        cwd: options.cwd,
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', serverLog.fd, serverLog.fd],
      });
      // Capture spawn failures without an unhandled EventEmitter error.
      child.on('error', () => {});
      await new Promise((done, reject) => {
        child.once('spawn', done);
        child.once('error', reject);
      });
    }
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: process.platform === 'linux',
      proxy: proxyFrom(process.env),
    });
    const readiness = await browser.newContext();
    try {
      await waitForUrl(readiness.request, options.url, options.timeout, child);
    } finally {
      await readiness.close();
    }
    const captures = [];
    for (const [name, device] of [
      ['desktop', { viewport: { width: 1440, height: 900 } }],
      ['mobile', devices['Pixel 7']],
    ]) {
      const context = await browser.newContext(device);
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(options.timeout);
        const response = await page.goto(options.url, {
          waitUntil: 'load',
          timeout: options.timeout,
        });
        if (!response?.ok())
          throw new Error(`${name}: page returned HTTP ${response?.status()}`);
        const expected = page.locator(options.selector).first();
        await expected.waitFor({ state: 'visible' });
        if (
          options.text &&
          !(await expected.innerText()).includes(options.text)
        )
          throw new Error(`${name}: expected text not found`);
        await page.evaluate(() => document.fonts.ready);
        const path = resolve(options.output, `${name}.png`);
        await page.screenshot({ path, fullPage: true, animations: 'disabled' });
        const bytes = await readFile(path);
        if (
          bytes.length < 8 ||
          bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        )
          throw new Error(`${name}: screenshot is not a PNG`);
        captures.push({
          name,
          path,
          bytes: (await stat(path)).size,
          viewport: page.viewportSize(),
          finalUrl: safeUrl(page.url()),
        });
      } finally {
        await context.close();
      }
    }
    const report = {
      success: true,
      playwright: (
        await import('playwright-core/package.json', { with: { type: 'json' } })
      ).default.version,
      chromium: browser.version(),
      sandbox: process.platform === 'linux',
      url: safeUrl(options.url),
      captures,
    };
    await writeFile(
      resolve(options.output, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    return report;
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await stopServer(child);
      } finally {
        await serverLog?.close();
        if (fixture) await new Promise((done) => fixture.close(done));
        process.removeListener('SIGINT', interruption);
        process.removeListener('SIGTERM', interruption);
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const options = optionsFrom(process.argv.slice(2));
    console.log(
      options.help ? help : JSON.stringify(await run(options), null, 2),
    );
  } catch (error) {
    // Do not print URLs containing credentials/query tokens, or environment data.
    console.error(
      String(error.message).replace(/https?:\/\/[^\s'"<>]+/g, (url) => {
        try {
          return safeUrl(url);
        } catch {
          return '[URL]';
        }
      }),
    );
    process.exitCode = 1;
  }
}
