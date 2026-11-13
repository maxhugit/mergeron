import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import i18n, { i18nReady } from '@/i18n';
import { ApprovalPurpose } from './approval-purpose';
import type { ApprovalRequest } from '@/types/approval';
const request = (
  operation: string,
  argumentsJson: string | null = JSON.stringify({
    operation,
    copyId: 'copy-bbcc',
    message: 'Créer la page',
  }),
): ApprovalRequest => ({
  requestId: '1',
  instanceId: 'immutable',
  kind: 'elicitation',
  threadId: 't',
  turnId: 'turn',
  itemId: '',
  status: 'pending',
  presentation: {
    kind: 'elicitation',
    supported: true,
    unsupportedReason: null,
    message: 'Allow tool?',
    serverName: 'mergeron_internal',
    cwd: null,
    environmentId: null,
    url: null,
    fields: [],
    permissions: [],
    tool: {
      name: 'project_git_local_manage',
      title: 'Local Git',
      titleFr: 'Git local',
      description: null,
      argumentsJson,
    },
  },
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});
it('explains the specific Git operation in French and shows its actual arguments', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  render(<ApprovalPurpose request={request('commit')} />);
  expect(await screen.findByText(/Créer un commit local/)).toBeVisible();
  expect(screen.getByText(/"copyId":\s*"copy-bbcc"/)).toBeVisible();
  expect(screen.getByText('Git local')).toBeVisible();
});
it('warns about loss of merge resolution edits and does not invent missing arguments', async () => {
  await i18nReady;
  const view = render(<ApprovalPurpose request={request('abort_merge')} />);
  expect(await screen.findByText(/will be lost/)).toBeVisible();
  view.rerender(<ApprovalPurpose request={request('commit', null)} />);
  expect(
    await screen.findByText(/complete arguments are not available/),
  ).toBeVisible();
  expect(screen.queryByText(/Create a local commit/)).toBeNull();
});
