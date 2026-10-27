import { chromium } from 'playwright-core';
import { publicProxy } from './public-proxy.mjs';
if (
  !process.env.BROWSER_WS_PATH ||
  !/^[a-zA-Z0-9_-]{32,128}$/.test(process.env.BROWSER_WS_PATH)
)
  throw new Error(
    'A random BROWSER_WS_PATH of 32–128 URL-safe characters is required',
  );
const proxy = publicProxy();
await new Promise((resolve) => proxy.listen(3129, '127.0.0.1', resolve));
const server = await chromium.launchServer({
  host: process.env.BROWSER_LISTEN_HOST || '0.0.0.0',
  port: 3000,
  wsPath: process.env.BROWSER_WS_PATH,
  chromiumSandbox: true,
  headless: true,
  proxy: { server: 'http://127.0.0.1:3129', bypass: '<-loopback>' },
  args: [
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  ],
});
// No endpoint/token or visited URL is logged.
console.log('Isolated browser ready');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    void server.close().finally(() => {
      proxy.close();
      process.exit(0);
    });
  });
