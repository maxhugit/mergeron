import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { ConfigService } from '@nestjs/config';
import { BrowserService } from './browser.service';

it.skipIf(!process.env.MERGERON_BROWSER_TEST_EXECUTABLE)(
  'returns to the same remote form and scroll position after using another agent',
  async () => {
    const fixture = createServer((_req, res) => {
      res.end(
        '<title>Fresh</title><body style="margin:0;height:3000px"><input style="width:200px;height:80px" oninput="document.title=this.value+\'|\'+scrollY"><script>onscroll=()=>document.title=document.querySelector("input").value+"|"+scrollY</script></body>',
      );
    });
    await new Promise<void>((resolve) =>
      fixture.listen(0, '127.0.0.1', resolve),
    );
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('No fixture');
    const server = await chromium.launchServer({
      executablePath: process.env.MERGERON_BROWSER_TEST_EXECUTABLE,
      headless: true,
      chromiumSandbox: true,
    });
    const service = new BrowserService(
      new ConfigService({ MERGERON_BROWSER_ENDPOINT: server.wsEndpoint() }),
    );
    try {
      const created = await service.run('agent-a', 'new', {});
      const tabId = 'id' in created ? created.id : '';
      const url = `http://127.0.0.1:${address.port}/`;
      const frame = await service.run('agent-a', 'navigate', { tabId, url });
      await service.run('agent-a', 'click', {
        tabId,
        frameId: 'frameId' in frame ? frame.frameId : '',
        x: 50,
        y: 30,
      });
      await service.run('agent-a', 'text', { tabId, text: 'Retained form' });
      await service.run('agent-a', 'scroll', { tabId, delta: 500 });
      await expect
        .poll(async () => {
          const result = await service.run('agent-a', 'snapshot', { tabId });
          return 'title' in result ? result.title : '';
        })
        .toMatch(/^Retained form\|[1-9][0-9]*$/);
      const before = await service.run('agent-a', 'snapshot', { tabId });
      await service.run('agent-b', 'new', {});
      await service.run('agent-a', 'keepalive', {});
      const tabs = await service.run('agent-a', 'tabs', { restoreOnly: true });
      expect('tabs' in tabs && tabs.tabs[0].id).toBe(tabId);
      const after = await service.run('agent-a', 'snapshot', { tabId });
      expect('title' in after && after.title).toBe(
        'title' in before && before.title,
      );
    } finally {
      await service.onModuleDestroy();
      await server.close();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  },
  30_000,
);

it.skipIf(!process.env.MERGERON_BROWSER_TEST_EXECUTABLE)(
  'keeps authentication popups in the isolated session, restores the opener and honors blocking',
  async () => {
    const fixture = createServer((req, res) => {
      res.end(
        req.url === '/popup'
          ? '<title>Authentication</title><button style="width:200px;height:100px" onclick="window.close()">Close</button>'
          : '<title>Opener</title><button style="width:200px;height:100px" onclick="window.open(\'/popup\')">Authenticate</button>',
      );
    });
    await new Promise<void>((resolve) =>
      fixture.listen(0, '127.0.0.1', resolve),
    );
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('No fixture');
    const server = await chromium.launchServer({
      executablePath: process.env.MERGERON_BROWSER_TEST_EXECUTABLE,
      headless: true,
      chromiumSandbox: true,
    });
    const service = new BrowserService(
      new ConfigService({ MERGERON_BROWSER_ENDPOINT: server.wsEndpoint() }),
    );
    try {
      for (const allowPopups of [true, false]) {
        const key = `popup-${allowPopups}`;
        const main = await service.run(key, 'new', { allowPopups });
        const tabId = 'id' in main ? main.id : '';
        const frame = await service.run(key, 'navigate', {
          tabId,
          url: `http://127.0.0.1:${address.port}/`,
        });
        await service.run(key, 'click', {
          tabId,
          frameId: 'frameId' in frame ? frame.frameId : '',
          x: 50,
          y: 50,
        });
        if (allowPopups) {
          await expect
            .poll(async () => {
              const result = await service.run(key, 'tabs', {});
              return 'tabs' in result ? result.tabs.length : 0;
            })
            .toBe(2);
          const result = await service.run(key, 'tabs', {});
          const popup =
            'tabs' in result ? result.tabs.find((tab) => tab.popup) : undefined;
          expect(popup).toBeTruthy();
          await expect
            .poll(async () => {
              const result = await service.run(key, 'snapshot', {
                tabId: popup!.id,
              });
              return 'title' in result ? result.title : '';
            })
            .toBe('Authentication');
          await service.run(key, 'remove', { tabId: popup!.id });
        }
        const remaining = await service.run(key, 'tabs', {});
        expect(
          'tabs' in remaining && remaining.tabs.map((tab) => tab.id),
        ).toEqual([tabId]);
        await service.run(key, 'dispose', {});
      }
    } finally {
      await service.onModuleDestroy();
      await server.close();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  },
  30_000,
);

// Explicit opt-in; loopback fixture access is for tests only. Production uses
// the public-only proxy and never accepts this executable/fixture override.
it.skipIf(!process.env.MERGERON_BROWSER_TEST_EXECUTABLE)(
  'navigates a framing-denied page in a real remote Chromium and selects its element',
  async () => {
    const fixture = createServer((_req, res) => {
      res.setHeader('X-Frame-Options', 'DENY');
      res.end(
        '<!doctype html><html><head><title>QA browser</title></head><body style="margin:0"><button onclick="document.title=\'Clicked\'" style="width:200px;height:100px">Change this button</button><input type="password" value="never-capture-this"><div id="count"></div><script>setInterval(()=>document.querySelector("#count").textContent=Date.now(),100)</script></body></html>',
      );
    });
    await new Promise<void>((resolve) =>
      fixture.listen(0, '127.0.0.1', resolve),
    );
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('No fixture');
    const server = await chromium.launchServer({
      executablePath: process.env.MERGERON_BROWSER_TEST_EXECUTABLE,
      headless: true,
      chromiumSandbox: true,
    });
    const service = new BrowserService(
      new ConfigService({ MERGERON_BROWSER_ENDPOINT: server.wsEndpoint() }),
    );
    try {
      const tab = await service.run('qa-owner', 'new', {});
      const tabId = 'id' in tab ? tab.id : '';
      const frame = await service.run('qa-owner', 'navigate', {
        tabId,
        url: `http://127.0.0.1:${address.port}/`,
      });
      expect('title' in frame && frame.title).toBe('QA browser');
      const selection = await service.run('qa-owner', 'select', {
        tabId,
        frameId: 'frameId' in frame ? frame.frameId : '',
        x: 80,
        y: 50,
      });
      expect('selection' in selection && selection.selection.element.tag).toBe(
        'button',
      );
      expect('selection' in selection && selection.selection.element.text).toBe(
        'Change this button',
      );
      expect('image' in selection && selection.image).toMatch(
        /^data:image\/jpeg;base64,/,
      );
      await expect(
        service.run('other-owner', 'snapshot', { tabId }),
      ).rejects.toThrow('not found');
      const abort = new AbortController();
      const events: Record<string, unknown>[] = [];
      const live = service.stream(
        'qa-owner',
        { tabId },
        abort.signal,
        (event) => {
          events.push(event);
          return Promise.resolve();
        },
        () => {},
      );
      try {
        await expect
          .poll(() => events.find((event) => event.type === 'ready'))
          .toBeTruthy();
        await expect
          .poll(() => events.filter((event) => event.type === 'frame').length)
          .toBeGreaterThan(2);
        const controlId = events.find(
          (event) => event.type === 'ready',
        )!.controlId;
        await expect(
          service.stream(
            'qa-owner',
            { tabId },
            new AbortController().signal,
            async () => {},
            () => {},
          ),
        ).rejects.toMatchObject({
          response: { code: 'BROWSER_CONTROL_REQUIRED' },
        });
        await expect(
          service.run('qa-owner', 'input', {
            tabId,
            controlId: 'wrong',
            events: [{ type: 'text', text: 'x' }],
          }),
        ).rejects.toMatchObject({
          response: { code: 'BROWSER_CONTROL_REQUIRED' },
        });
        const base = {
          tabId,
          controlId,
          width: 1000,
          height: 700,
          url: `http://127.0.0.1:${address.port}/`,
        };
        await service.run('qa-owner', 'input', {
          ...base,
          events: [
            {
              type: 'pointer',
              phase: 'down',
              button: 'left',
              clickCount: 1,
              x: 80,
              y: 50,
            },
            {
              type: 'pointer',
              phase: 'up',
              button: 'left',
              clickCount: 1,
              x: 80,
              y: 50,
            },
          ],
        });
        await expect
          .poll(() => events.find((event) => event.title === 'Clicked'))
          .toBeTruthy();
        await service.run('qa-owner', 'input', {
          ...base,
          events: [{ type: 'resize', width: 800, height: 500 }],
        });
        await expect
          .poll(() =>
            events.find((event) => event.width === 800 && event.height === 500),
          )
          .toBeTruthy();
        await expect(
          service.run('qa-owner', 'input', {
            ...base,
            events: [{ type: 'text', text: 'stale' }],
          }),
        ).rejects.toMatchObject({ response: { code: 'BROWSER_STALE_VIEW' } });
      } finally {
        abort.abort();
        await live;
      }
    } finally {
      await service.onModuleDestroy();
      await server.close();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  },
  60_000,
);
