import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { WorkspaceCreationDialog } from './workspace-creation-dialog';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

afterEach(cleanup);

test.each([360, 640, 1252])(
  'keeps connection fields and actions inside the dialog at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    const onCreateLocal = vi.fn();
    const onCreateExternal = vi.fn();
    render(
      <WorkspaceCreationDialog
        open
        pending={false}
        onClose={() => {}}
        onCreateLocal={onCreateLocal}
        onCreateExternal={onCreateExternal}
      />,
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Ajouter un emplacement ou une connexion',
    });
    await expect
      .poll(() => Math.round(Number.parseFloat(getComputedStyle(dialog).width)))
      .toBe(Math.min(672, width - 32));
    const expectContained = () => {
      const bounds = dialog.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(15);
      expect(bounds.right).toBeLessThanOrEqual(width - 15);
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
      for (const control of dialog.querySelectorAll(
        'input, select, textarea, button',
      )) {
        const rect = control.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
        expect(rect.right).toBeLessThanOrEqual(bounds.right);
      }
    };
    expectContained();
    fireEvent.click(screen.getByRole('button', { name: /^SSH/ }));
    for (const type of ['ssh', 'git', 'sftp', 'ftps', 'ftp']) {
      fireEvent.change(
        screen.getByRole('combobox', { name: 'Type de connexion' }),
        { target: { value: type } },
      );
      expectContained();
      expect(Number.parseFloat(getComputedStyle(dialog).width)).toBeCloseTo(
        Math.min(672, width - 32),
        0,
      );
    }
    expect(onCreateLocal).not.toHaveBeenCalled();
    expect(onCreateExternal).not.toHaveBeenCalled();
  },
);
