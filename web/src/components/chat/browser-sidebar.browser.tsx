import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { page, userEvent } from 'vitest/browser';
import { BrowserSidebar } from './browser-sidebar';
import { markedScreenshot } from '@/lib/browser-annotations';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-api', () => ({ browserApi: api }));
beforeEach(() => {
  api.mockReset().mockResolvedValue({ tabs: [] });
});
afterEach(cleanup);
test('edits an address and opens it with Enter from an empty browser session', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  await page.viewport(1214, 988);
  api.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith('/new')
        ? {
            id: 'created',
            tabs: [{ id: 'created', url: 'about:blank', title: '' }],
          }
        : path.endsWith('/navigate')
          ? {
              frameId: 'frame',
              url: 'https://example.org/',
              title: 'Example',
              image:
                'data:image/svg+xml,' +
                encodeURIComponent(
                  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><text x="20" y="40">Example</text></svg>',
                ),
              width: 600,
              height: 200,
            }
          : { tabs: [] },
    ),
  );
  render(<BrowserSidebar threadId="fixture" onClose={() => {}} />);
  const address = page.getByRole('textbox', { name: 'Adresse de la page' });
  await expect.element(address).toBeEnabled();
  await address.fill('https://example.org/');
  await userEvent.keyboard('{Enter}');
  await expect
    .element(page.getByRole('img', { name: 'Page web distante' }))
    .toBeVisible();
  expect(api).toHaveBeenCalledWith('/fixture/navigate', {
    tabId: 'created',
    url: 'https://example.org/',
  });
  expect(
    api.mock.calls.filter(([path]) => String(path).endsWith('/new')),
  ).toHaveLength(1);
});
test.each([390, 1280])('browser panel fits a %s px viewport', async (width) => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  await page.viewport(width, 800);
  render(
    <div style={{ display: 'flex', width: '100vw', height: 700 }}>
      <div style={{ flex: 1 }}>Conversation</div>
      <BrowserSidebar threadId="fixture" onClose={() => {}} />
    </div>,
  );
  await expect
    .element(page.getByRole('heading', { name: 'Navigateur' }))
    .toBeVisible();
  const bounds = document.querySelector('aside')!.getBoundingClientRect();
  expect(bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.right).toBeLessThanOrEqual(width + 1);
  expect(document.querySelector('iframe[src]')).toBeNull();
});
test('renders the numbered annotation into a real PNG attachment', async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="white"/></svg>';
  const file = await markedScreenshot(
    'data:image/svg+xml;base64,' + btoa(svg),
    { x: 30, y: 40, width: 100, height: 50 },
  );
  expect(file.type).toBe('image/png');
  expect(file.size).toBeGreaterThan(100);
  const image = new Image();
  const url = URL.createObjectURL(file);
  image.src = url;
  try {
    await image.decode();
    expect(image.naturalWidth).toBe(300);
    expect(image.naturalHeight).toBe(200);
  } finally {
    URL.revokeObjectURL(url);
  }
});
