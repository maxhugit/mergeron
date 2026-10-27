import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { page } from 'vitest/browser';
import { BrowserSidebar } from './browser-sidebar';
import { markedScreenshot } from '@/lib/browser-annotations';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
vi.mock('@/lib/browser-api', () => ({
  browserApi: () => Promise.resolve({ tabs: [] }),
}));
afterEach(cleanup);
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
