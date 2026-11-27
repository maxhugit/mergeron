import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { page } from 'vitest/browser';
import { AgentCreationWorkspaceChoices } from './agent-creation-workspace-choices';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

afterEach(cleanup);
test.each([390, 1100])(
  'offers local spaces only and preserves compact long names at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 800);
    const select = vi.fn();
    const workspace = {
      projectId: 'p',
      primary: false,
      createdAt: 1,
      updatedAt: 1,
    };
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Choisir un dossier de travail</AlertDialogTitle>
            <AlertDialogDescription>
              Choisissez le contexte de fichiers et d’exécution de cette
              conversation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AgentCreationWorkspaceChoices
            workspaces={[
              {
                ...workspace,
                id: 'main',
                path: '/workspace',
                name: 'Main',
                primary: true,
              },
              {
                ...workspace,
                id: 'local',
                path: '/workspace/local',
                name: 'Dossier local de préparation avec un nom volontairement très long',
              },
              {
                ...workspace,
                id: 'other-copy',
                path: '/copy/other',
                name: 'Copie de l’autre agent',
                sourceResourceId: 'git',
              },
            ]}
            onSelect={select}
          />
        </AlertDialogContent>
      </AlertDialog>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(
      screen.queryByText('Copie de l’autre agent'),
    ).not.toBeInTheDocument();
    expect(buttons[0].getBoundingClientRect().height).toBe(
      buttons[1].getBoundingClientRect().height,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/agent-workspace-choice-${width}.png`,
    });
    await page
      .getByRole('button', { name: /Dossier local de préparation/ })
      .click();
    expect(select).toHaveBeenCalledWith('/workspace/local');
  },
);
