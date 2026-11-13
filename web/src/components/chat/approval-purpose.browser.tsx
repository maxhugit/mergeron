import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { InteractionCard } from './turn-items/interaction-card';
import type { ApprovalRequest } from '@/types/approval';
afterEach(cleanup);
test.each([390, 1100])(
  'shows an explicit French authorization with arguments at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 900);
    const request: ApprovalRequest = {
      kind: 'elicitation',
      threadId: 'fixture',
      turnId: 'turn',
      itemId: '',
      requestId: 'request',
      instanceId: 'instance',
      status: 'pending',
      presentation: {
        kind: 'elicitation',
        supported: true,
        unsupportedReason: null,
        message:
          'Allow the mergeron_internal MCP server to run tool "project_git_local_manage"?',
        serverName: 'mergeron_internal',
        cwd: null,
        environmentId: null,
        url: null,
        permissions: [],
        fields: [],
        tool: {
          name: 'project_git_local_manage',
          title: 'Local Git',
          titleFr:
            'Git — Préparer, committer, intégrer ou restaurer les modifications locales',
          description: 'Stage or commit local changes.',
          argumentsJson: JSON.stringify(
            {
              operation: 'commit',
              copyId: 'copie-bbcc',
              message: 'Ajouter la page des adhérents',
              expectedRevision: '8365e8d',
              paths: ['src/app/membres/page.tsx'],
            },
            null,
            2,
          ),
        },
      },
    };
    render(
      <main className="min-h-dvh bg-background p-4 text-foreground">
        <div className="mx-auto max-w-xl">
          <InteractionCard request={request} />
        </div>
      </main>,
    );
    expect(
      await screen.findByText('Autorisation d’un outil MCP'),
    ).toBeVisible();
    expect(screen.getByText(/Créer un commit local avec/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Autoriser cet appel' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refuser' })).toBeVisible();
    expect(screen.getByText(/"operation": "commit"/)).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/approval-purpose-${width}.png`,
    });
  },
);
