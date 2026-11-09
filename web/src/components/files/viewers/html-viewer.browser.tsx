import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { commands, page } from 'vitest/browser';
import { HtmlViewer } from './html-viewer';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
vi.mock('./preview-source', async (load) => ({
  ...(await load<typeof import('./preview-source')>()),
  fetchPreviewText: async () =>
    '<style>body{font:18px sans-serif;padding:24px}button{padding:12px}</style><h1>Project dashboard</h1><p id="state">Published revision</p><button onclick="document.getElementById(\'state\').textContent=\'Interactive archive\'">Next</button>',
}));
vi.mock('./code-viewer', () => ({
  CodeViewer: () => <div>Saved HTML source</div>,
}));
afterEach(cleanup);
test('opens a saved deliverable as an interactive isolated preview on desktop and mobile', async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  for (const width of [1100, 390]) {
    await page.viewport(width, 760);
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <div style={{ height: 600 }}>
          <HtmlViewer
            source={{ kind: 'file', filePath: '/livrables/mockup-saved.html' }}
            viewId="archived"
            active
            readOnly
          />
        </div>
      </QueryClientProvider>,
    );
    expect(await commands.mockupPreview('ready')).toContain(
      'Published revision',
    );
    expect(await commands.mockupPreview('next')).toContain(
      'Interactive archive',
    );
    expect(screen.getByTitle('mockup-saved.html')).toHaveAttribute(
      'sandbox',
      'allow-scripts',
    );
    await page.screenshot({
        path: `../../../../.vitest-screenshots/deliverable-html-${width}.png`,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Source code' }));
    expect(await screen.findByText('Saved HTML source')).toBeVisible();
    view.unmount();
  }
});
