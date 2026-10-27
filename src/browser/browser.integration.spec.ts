import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { ConfigService } from '@nestjs/config';
import { BrowserService } from './browser.service';

// Explicit opt-in; loopback fixture access is for tests only. Production uses
// the public-only proxy and never accepts this executable/fixture override.
it.skipIf(!process.env.MERGERON_BROWSER_TEST_EXECUTABLE)(
  'navigates a framing-denied page in a real remote Chromium and selects its element',
  async () => {
    const fixture = createServer((_req, res) => {
      res.setHeader('X-Frame-Options', 'DENY');
      res.end(
        '<!doctype html><html><head><title>QA browser</title></head><body style="margin:0"><button style="width:200px;height:100px">Change this button</button><input type="password" value="never-capture-this"></body></html>',
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
    } finally {
      await service.onModuleDestroy();
      await server.close();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  },
  60_000,
);
