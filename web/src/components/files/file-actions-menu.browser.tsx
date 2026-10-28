import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { page } from 'vitest/browser';
import { Eye, MessageSquarePlus, Trash2 } from 'lucide-react';
import { FileActionsMenu } from './file-actions-menu';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

afterEach(cleanup);
test.each([390, 1280])(
  'opens actions only with right-click or overflow at %ipx',
  async (width) => {
    await page.viewport(width, 800);
    await i18nReady;
    await i18n.changeLanguage('en');
    const open = vi.fn(),
      attach = vi.fn();
    render(
      <div style={{ width: 300, margin: 30 }}>
        <FileActionsMenu
          actions={[
            { id: 'view', label: 'Preview', icon: Eye, onSelect: vi.fn() },
            {
              id: 'attach',
              label: 'Attach to chat',
              icon: MessageSquarePlus,
              onSelect: attach,
              separated: true,
            },
            {
              id: 'delete',
              label: 'Delete',
              icon: Trash2,
              onSelect: vi.fn(),
              separated: true,
              destructive: true,
            },
          ]}
        >
          <button onClick={open} className="min-w-0 flex-1 text-left">
            report.docx
          </button>
        </FileActionsMenu>
      </div>,
    );
    await page.getByRole('button', { name: 'report.docx' }).click();
    expect(open).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    await page
      .getByRole('button', { name: 'report.docx' })
      .click({ button: 'right' });
    const attachment = await screen.findByRole('menuitem', {
      name: 'Attach to chat',
    });
    expect(attachment.previousElementSibling).toHaveAttribute(
      'role',
      'separator',
    );
    expect(attachment.nextElementSibling).toHaveAttribute('role', 'separator');
    expect(attachment.nextElementSibling?.nextElementSibling).toHaveTextContent(
      'Delete',
    );
    await page.getByRole('menuitem', { name: 'Attach to chat' }).click();
    await expect.poll(() => attach.mock.calls.length).toBe(1);
    await page.getByRole('button', { name: 'Actions' }).click();
    expect(
      await screen.findByRole('menuitem', { name: 'Preview' }),
    ).toBeVisible();
    expect(open).toHaveBeenCalledOnce();
    const menu = screen.getByRole('menu').getBoundingClientRect();
    expect(menu.left).toBeGreaterThanOrEqual(0);
    expect(menu.right).toBeLessThanOrEqual(width);
  },
);
