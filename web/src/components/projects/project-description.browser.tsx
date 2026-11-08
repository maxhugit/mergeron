import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { CreateProjectDialog } from '../chat/sidebar/create-project-dialog';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
vi.mock('@/lib/platform-session', () => ({
  usePlatformSession: () => ({ isAdministrator: true }),
}));
afterEach(cleanup);
test.each([390, 1100])(
  'shows a multiline project description at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 900);
    render(
      <CreateProjectDialog
        open
        pending={false}
        name="Mon projet"
        onNameChange={() => {}}
        onSave={() => {}}
        onClose={() => {}}
      />,
    );
    const field = screen.getByLabelText('Description courte');
    fireEvent.change(field, {
      target: { value: 'Objectif du projet\nLivrables attendus et périmètre.' },
    });
    expect(field).toHaveValue(
      'Objectif du projet\nLivrables attendus et périmètre.',
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/project-description-${width}.png`,
    });
  },
);
