import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { ImageViewItem } from './turn-items/rich-activity-items';
vi.mock('@/auth-token', async (original) => ({
  ...(await original<typeof import('@/auth-token')>()),
  buildFileServeUrl: () =>
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#dbeafe"/><text x="30" y="90" fill="#1e3a8a">Image consultée</text></svg>',
    ),
}));
afterEach(cleanup);
test.each([390, 1100])(
  'opens an inspected image in the existing viewer at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 800);
    render(
      <main className="min-h-dvh bg-background p-4 text-foreground">
        <ImageViewItem
          item={{
            type: 'imageView',
            itemId: 'image',
            completed: true,
            path: '/workspaces/demo/maquette.png',
          }}
        />
      </main>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /maquette.png/ }));
    const dialog = await screen.findByRole('dialog');
    const image = screen.getByRole('img', { name: 'maquette.png' });
    await vi.waitFor(() =>
      expect((image as HTMLImageElement).naturalWidth).toBe(320),
    );
    await user.click(screen.getByTitle(i18n.t('zoomIn')));
    expect(screen.getByText('125%')).toBeVisible();
    expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/inspected-image-${width}.png`,
    });
    fireEvent.error(image);
    expect(screen.getByText(i18n.t('failedToLoadImage'))).toBeVisible();
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  },
);
