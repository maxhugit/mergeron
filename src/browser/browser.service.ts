import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  applyBrowserInput,
  browserInput,
  streamBrowserPage,
} from './browser-live';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright-core';

export const VIEWPORT = { width: 1000, height: 700 };
export function browserUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096)
    throw new BadRequestException({
      code: 'BROWSER_INVALID_URL',
      message: 'Invalid URL',
    });
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException({
      code: 'BROWSER_INVALID_URL',
      message: 'Invalid URL',
    });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new BadRequestException({
      code: 'BROWSER_INVALID_URL',
      message: 'Use HTTP(S) without URL credentials',
    });
  return url.href;
}
type Tab = {
  page: Page;
  frameId?: string;
  capturedUrl?: string;
  image?: string;
};
type Session = {
  browser: Browser;
  context: BrowserContext;
  tabs: Map<string, Tab>;
  busy: boolean;
  touched: number;
  live?: {
    tabId: string;
    controlId: string;
    abort: AbortController;
    done: Promise<void>;
  };
};

/** Only pixels and bounded element metadata cross from the isolated browser to Mergeron. */
@Injectable()
export class BrowserService implements OnModuleDestroy {
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Set<string>();
  private readonly sweep = setInterval(() => {
    for (const [key, session] of this.sessions)
      if (!session.busy && Date.now() - session.touched > 15 * 60_000)
        void this.close(key);
  }, 60_000).unref();
  constructor(private readonly config: ConfigService) {}
  async onModuleDestroy() {
    clearInterval(this.sweep);
    await Promise.all([...this.sessions.keys()].map((key) => this.close(key)));
  }
  private async close(key: string) {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    session?.live?.abort.abort();
    await session?.browser.close().catch(() => {});
  }
  private async session(key: string): Promise<Session> {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const endpoint = this.config.get<string>('MERGERON_BROWSER_ENDPOINT');
    if (!endpoint)
      throw new ServiceUnavailableException({
        code: 'BROWSER_NOT_CONFIGURED',
        message: 'Browser runtime is not configured',
      });
    if (this.opening.has(key) || this.sessions.size + this.opening.size >= 8)
      throw new ConflictException({
        code: 'BROWSER_BUSY',
        message: 'Browser capacity reached',
      });
    this.opening.add(key);
    let browser: Browser | undefined;
    try {
      browser = await chromium.connect(endpoint, { timeout: 15_000 });
      const context = await browser.newContext({
        viewport: VIEWPORT,
        acceptDownloads: false,
        serviceWorkers: 'block',
        permissions: [],
      });
      context.setDefaultTimeout(5000);
      context.setDefaultNavigationTimeout(20_000);
      // The runtime also enforces public-only, DNS-pinned egress. This protocol
      // filter is defense in depth, not an SSRF boundary by itself.
      await context.route('**/*', async (route) => {
        const protocol = new URL(route.request().url()).protocol;
        if (!['http:', 'https:'].includes(protocol)) await route.abort();
        else await route.continue();
      });
      await context.routeWebSocket('**/*', (socket) => socket.close());
      context.on('page', (page) => {
        // Popups are not silently accepted as extra tabs or allowed to escape quotas.
        page.on('popup', (popup) => {
          void popup.close();
        });
        page.on('download', (download) => {
          void download.cancel();
        });
        page.on('dialog', (dialog) => {
          void dialog.dismiss();
        });
      });
      const session = {
        browser,
        context,
        tabs: new Map<string, Tab>(),
        busy: false,
        touched: Date.now(),
      };
      this.sessions.set(key, session);
      return session;
    } catch {
      await browser?.close().catch(() => {});
      throw new ServiceUnavailableException({
        code: 'BROWSER_RUNTIME_UNAVAILABLE',
        message: 'Browser runtime unavailable',
      });
    } finally {
      this.opening.delete(key);
    }
  }
  async run(key: string, action: string, body: Record<string, unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.operate(key, action, body),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.close(key);
            reject(
              new ServiceUnavailableException({
                code: 'BROWSER_TIMEOUT',
                message: 'Browser operation timed out; session closed',
              }),
            );
          }, 35_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async stream(
    key: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    emit: (event: Record<string, unknown>) => Promise<void>,
    authorize: () => void,
  ) {
    const session = this.sessions.get(key);
    const tabId = typeof body.tabId === 'string' ? body.tabId : '';
    const tab = session?.tabs.get(tabId);
    if (!session || !tab)
      throw new NotFoundException({ code: 'BROWSER_TAB_MISSING' });
    if (session.busy) throw new ConflictException({ code: 'BROWSER_BUSY' });
    const previous = session.live;
    if (previous) {
      if (body.takeControl !== true)
        throw new ConflictException({ code: 'BROWSER_CONTROL_REQUIRED' });
      previous.abort.abort();
      await previous.done.catch(() => {});
    }
    authorize();
    if (signal.aborted) return;
    // A concurrent claimant may have acquired the lease while cleanup awaited.
    if (session.live && session.live !== previous)
      throw new ConflictException({ code: 'BROWSER_CONTROL_REQUIRED' });
    if (this.sessions.get(key) !== session || tab.page.isClosed())
      throw new NotFoundException({ code: 'BROWSER_TAB_MISSING' });
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, abort.signal]);
    const controlId = randomUUID();
    const live = { tabId, controlId, abort, done: Promise.resolve() };
    session.live = live;
    live.done = streamBrowserPage(
      session.context,
      tab.page,
      combined,
      async (event) => {
        session.touched = Date.now();
        await emit(event);
      },
      authorize,
      controlId,
    );
    try {
      await live.done;
    } finally {
      if (session.live === live) session.live = undefined;
    }
  }
  private async operate(
    key: string,
    action: string,
    body: Record<string, unknown>,
  ) {
    const current = this.sessions.get(key);
    if (
      current?.live &&
      !['tabs', 'snapshot'].includes(action) &&
      body.controlId !== current.live.controlId
    )
      throw new ConflictException({ code: 'BROWSER_CONTROL_REQUIRED' });
    if (action === 'close') {
      if (this.opening.has(key))
        throw new ConflictException('Browser is opening; retry closing');
      await this.close(key);
      return { closed: true };
    }
    const session = await this.session(key);
    if (session.busy)
      throw new ConflictException({
        code: 'BROWSER_BUSY',
        message: 'Browser operation in progress',
      });
    session.busy = true;
    session.touched = Date.now();
    try {
      if (action === 'tabs') return await this.tabs(session);
      if (action === 'new') {
        if (session.tabs.size >= 5)
          throw new ConflictException({
            code: 'BROWSER_TAB_LIMIT',
            message: 'Maximum five browser tabs',
          });
        const id = randomUUID();
        session.tabs.set(id, { page: await session.context.newPage() });
        return { id, ...(await this.tabs(session)) };
      }
      const id = typeof body.tabId === 'string' ? body.tabId : '';
      const tab = session.tabs.get(id);
      if (!tab)
        throw new NotFoundException({
          code: 'BROWSER_TAB_MISSING',
          message: 'Browser tab not found',
        });
      const page = tab.page;
      if (action === 'input') {
        if (
          !session.live ||
          session.live.tabId !== id ||
          body.controlId !== session.live.controlId
        )
          throw new ConflictException({ code: 'BROWSER_CONTROL_REQUIRED' });
        const size = page.viewportSize();
        if (
          body.url !== page.url() ||
          body.width !== size?.width ||
          body.height !== size?.height
        )
          throw new ConflictException({ code: 'BROWSER_STALE_VIEW' });
        if (
          !Array.isArray(body.events) ||
          !body.events.length ||
          body.events.length > 32
        )
          throw new BadRequestException('Invalid input batch');
        const events = body.events.map(browserInput);
        const lease = session.live;
        for (const event of events) {
          if (session.live !== lease || lease.abort.signal.aborted)
            throw new ConflictException({ code: 'BROWSER_CONTROL_REQUIRED' });
          if (page.url() !== body.url)
            throw new ConflictException({ code: 'BROWSER_STALE_VIEW' });
          await applyBrowserInput(page, event);
        }
        return { applied: true };
      }
      if (action === 'remove') {
        session.tabs.delete(id);
        await page.close();
        return await this.tabs(session);
      }
      if (action === 'navigate')
        await page.goto(browserUrl(body.url), {
          waitUntil: 'domcontentloaded',
        });
      else if (action === 'back')
        await page.goBack({ waitUntil: 'domcontentloaded' });
      else if (action === 'forward')
        await page.goForward({ waitUntil: 'domcontentloaded' });
      else if (action === 'reload')
        await page.reload({ waitUntil: 'domcontentloaded' });
      else if (action === 'click' || action === 'select') {
        if (
          typeof body.frameId !== 'string' ||
          body.frameId !== tab.frameId ||
          page.url() !== tab.capturedUrl
        )
          throw new ConflictException(
            'Refresh the browser image before pointing',
          );
        const x = Number(body.x),
          y = Number(body.y);
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 ||
          x >= (page.viewportSize()?.width ?? VIEWPORT.width) ||
          y < 0 ||
          y >= (page.viewportSize()?.height ?? VIEWPORT.height)
        )
          throw new BadRequestException('Invalid point');
        if (action === 'select') {
          const element = await page.evaluate(
            ({ x, y }) => {
              let element = document.elementFromPoint(x, y);
              for (let depth = 0; depth < 32; depth++) {
                const child = element?.shadowRoot?.elementFromPoint(x, y);
                if (!child || child === element) break;
                element = child;
              }
              if (!element) return null;
              const box = element.getBoundingClientRect();
              const parts: string[] = [];
              for (
                let node: Element | null = element;
                node && parts.length < 8;
                node = node.parentElement
              ) {
                const parent: Element | null = node.parentElement;
                const index = parent
                  ? [...parent.children].indexOf(node) + 1
                  : 1;
                parts.unshift(
                  `${node.tagName.toLowerCase()}:nth-child(${index})`,
                );
              }
              return {
                tag: element.tagName.toLowerCase(),
                text: element.matches('input,textarea,[contenteditable]')
                  ? ''
                  : (element.textContent ?? '').trim().slice(0, 1000),
                role: element.getAttribute('role'),
                selector: parts.join(' > '),
                frame: element.tagName === 'IFRAME',
                box: {
                  x: box.x,
                  y: box.y,
                  width: box.width,
                  height: box.height,
                },
              };
            },
            { x, y },
          );
          if (!element)
            throw new BadRequestException('No element at this point');
          // Cross-origin frames are labelled as frames, never misrepresented as their children.
          const previousImage = tab.image;
          const snapshot = await this.snapshot(tab);
          if (snapshot.image !== previousImage)
            throw new ConflictException(
              'Page changed; refresh before pointing',
            );
          return {
            ...snapshot,
            selection: {
              id: randomUUID(),
              url: page.url(),
              element,
              point: { x, y },
              capturedAt: new Date().toISOString(),
            },
          };
        }
        await page.mouse.click(x, y);
      } else if (action === 'scroll') {
        const delta = Number(body.delta);
        if (!Number.isFinite(delta) || Math.abs(delta) > 1400)
          throw new BadRequestException('Invalid scroll');
        await page.mouse.wheel(0, delta);
      } else if (action === 'key') {
        if (
          ![
            'Enter',
            'Tab',
            'Shift+Tab',
            'Backspace',
            'Escape',
            'ArrowUp',
            'ArrowDown',
            'ArrowLeft',
            'ArrowRight',
          ].includes(String(body.key))
        )
          throw new BadRequestException('Invalid key');
        await page.keyboard.press(String(body.key));
      } else if (action === 'text') {
        if (typeof body.text !== 'string' || body.text.length > 2000)
          throw new BadRequestException('Invalid text');
        await page.keyboard.insertText(body.text);
      } else if (
        !['snapshot', 'navigate', 'back', 'forward', 'reload'].includes(action)
      )
        throw new BadRequestException('Unknown browser action');
      return await this.snapshot(tab);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        code: ['navigate', 'back', 'forward', 'reload'].includes(action)
          ? 'BROWSER_NAVIGATION_FAILED'
          : 'BROWSER_OPERATION_FAILED',
        message: 'Browser operation failed; refresh or navigate again',
      });
    } finally {
      session.busy = false;
      session.touched = Date.now();
    }
  }
  private async tabs(session: Session) {
    return {
      tabs: await Promise.all(
        [...session.tabs].map(async ([id, tab]) => ({
          id,
          url: tab.page.url(),
          title: (await tab.page.title().catch(() => '')).slice(0, 200),
        })),
      ),
    };
  }
  private async snapshot(tab: Tab) {
    const image = await tab.page.screenshot({
      type: 'jpeg',
      animations: 'disabled',
      quality: 65,
      timeout: 8000,
      mask: [tab.page.locator('input,textarea,[contenteditable]')],
    });
    tab.frameId = randomUUID();
    tab.capturedUrl = tab.page.url();
    tab.image = `data:image/jpeg;base64,${image.toString('base64')}`;
    return {
      frameId: tab.frameId,
      url: tab.page.url(),
      title: (await tab.page.title()).slice(0, 200),
      image: tab.image,
      ...(tab.page.viewportSize() ?? VIEWPORT),
    };
  }
}
