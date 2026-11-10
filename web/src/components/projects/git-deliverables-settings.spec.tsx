import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalogFixture, json } from '../settings/catalog/catalog.testing';
import { GitDeliverablesSettings } from './git-deliverables-settings';
import { GitDeliverablesDiscovery } from './git-deliverables-discovery';

let fixture: ReturnType<typeof catalogFixture>;
let writes: { url: string; body: Record<string, unknown> }[];
let conflict: boolean;
let partial: boolean;
let applied: boolean;
beforeEach(() => {
  fixture = catalogFixture();
  writes = [];
  conflict = false;
  partial = false;
  applied = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (url.endsWith('/apply')) applied = true;
        writes.push({
          url,
          body: JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          ) as Record<string, unknown>,
        });
        return Promise.resolve(
          json(
            url.endsWith('/preview')
              ? {
                  fingerprint: 'reviewed-plan',
                  canApply: !conflict || (partial && !applied),
                  changes: [
                    {
                      deliverable: 'Cadrage',
                      document: 'notes.md',
                      action: conflict ? 'conflict' : 'import',
                      reason: conflict
                        ? 'document_changed_both'
                        : 'new_document',
                    },
                  ],
                }
              : {
                  enabled: true,
                  ...(partial
                    ? {
                        remaining: [
                          {
                            deliverable: 'Cadrage',
                            document: 'notes.md',
                            action: 'conflict',
                            reason: 'document_changed_both',
                          },
                        ],
                      }
                    : {}),
                },
          ),
        );
      }
      return Promise.resolve(
        json({
          boards: [
            {
              id: 'board',
              name: 'Deliverables',
              settings: null,
              restricted: [{ id: 'secret', title: 'Restricted document' }],
            },
          ],
          copies: [
            {
              id: 'copy',
              name: 'Shared Git',
              writable: true,
              owned: true,
              eligible: true,
            },
          ],
          discovered: [{ id: 'remote', title: 'Cadrage', documents: 1 }],
          discoveryError: null,
        }),
      );
    }),
  );
});
afterEach(() => {
  fixture.dispose();
  vi.unstubAllGlobals();
});

it('configures the project without a manager selector or copy selector', async () => {
  const user = userEvent.setup();
  fixture.render(<GitDeliverablesSettings projectId="p" />);
  await user.click(await screen.findByRole('switch'));
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Preview changes' })).toBeNull();
  await user.click(
    screen.getByRole('button', { name: 'Save Git deliverables mode' }),
  );
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].url).toContain('/configure');
  expect(writes[0].body).toEqual({
    boardId: 'board',
    enabled: true,
    directory: 'livrables',
    restrictedIds: [],
  });
});
it('allows saving the mode without an agent copy and explains deferred export', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        json({
          boards: [
            {
              id: 'board',
              name: 'Deliverables',
              settings: null,
              restricted: [],
            },
          ],
          copies: [],
          discovered: [],
          discoveryError: null,
        }),
      ),
    ),
  );
  const user = userEvent.setup();
  fixture.render(<GitDeliverablesSettings projectId="p" />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'No writable agent Git copy',
  );
  await user.click(await screen.findByRole('switch'));
  expect(
    screen.getByRole('button', { name: 'Save Git deliverables mode' }),
  ).toBeEnabled();
  await user.click(
    screen.getByRole('button', { name: 'Save Git deliverables mode' }),
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/configure'),
      expect.objectContaining({ method: 'POST' }),
    ),
  );
});

it('keeps each copy error visible and opens review in its own branch context', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        json({
          boards: [
            {
              id: 'board',
              name: 'Deliverables',
              restricted: [],
              settings: {
                enabled: true,
                directory: 'livrables',
                restrictedIds: [],
                lastError: null,
                lastSyncAt: null,
              },
            },
          ],
          copies: [
            {
              id: 'first',
              name: 'Agent A',
              eligible: true,
              writable: true,
              owned: true,
              lastError: 'GIT_DELIVERABLES_REVIEW_REQUIRED',
              context: { branch: 'refs/heads/work-A', head: 'aaaaaaaa' },
            },
            {
              id: 'second',
              name: 'Agent B',
              eligible: true,
              writable: true,
              owned: true,
              lastError: null,
              pending: true,
              context: { branch: 'refs/heads/work-B', head: 'bbbbbbbb' },
            },
          ],
          discovered: [],
          discoveryError: null,
        }),
      ),
    ),
  );
  const user = userEvent.setup();
  fixture.render(<GitDeliverablesSettings projectId="p" />);
  const table = await screen.findByRole('region', {
    name: 'Git copy synchronization',
  });
  expect(table).toHaveTextContent('Agent A');
  expect(table).toHaveTextContent('GIT_DELIVERABLES_REVIEW_REQUIRED');
  expect(table).toHaveTextContent('work-A');
  expect(table).toHaveTextContent('work-B');
  expect(table).toHaveTextContent('Export pending');
  await user.click(
    screen.getAllByRole('button', { name: 'Review Git deliverables' })[1],
  );
  expect(await screen.findByRole('dialog')).toHaveTextContent('Agent B');
  expect(screen.getByRole('dialog')).toHaveTextContent('work-B');
  expect(screen.getByRole('dialog')).not.toHaveTextContent(
    'GIT_DELIVERABLES_REVIEW_REQUIRED',
  );
});
it('requires explicit opt-in and review, excludes restricted content and cancels a stale preview on edits', async () => {
  const user = userEvent.setup();
  fixture.render(
    <GitDeliverablesSettings projectId="p" preferredCopyId="copy" />,
  );
  const enabled = await screen.findByRole('switch', {
    name: 'Enable Git deliverables',
  });
  expect(enabled).not.toBeChecked();
  expect(writes).toEqual([]);
  await user.click(enabled);
  await user.click(screen.getByRole('button', { name: 'Preview changes' }));
  await screen.findByRole('button', { name: 'Confirm and synchronize' });
  expect(writes[0].body).toMatchObject({
    restrictedIds: [],
    adoptFolders: false,
  });
  const directory = screen.getByRole('textbox', {
    name: 'Repository directory',
  });
  await user.clear(directory);
  await user.type(directory, 'documents');
  expect(
    screen.queryByRole('button', { name: 'Confirm and synchronize' }),
  ).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Preview changes' }));
  await user.click(
    await screen.findByRole('button', { name: 'Confirm and synchronize' }),
  );
  await waitFor(() =>
    expect(writes.at(-1)).toEqual(
      expect.objectContaining({
        body: {
          options: expect.objectContaining({
            directory: 'documents',
            restrictedIds: [],
          }) as unknown,
          fingerprint: 'reviewed-plan',
        },
      }),
    ),
  );
});
it('does not allow applying only conflicting documents', async () => {
  conflict = true;
  const user = userEvent.setup();
  fixture.render(
    <GitDeliverablesSettings projectId="p" preferredCopyId="copy" />,
  );
  await user.click(await screen.findByRole('switch'));
  await user.click(screen.getByRole('button', { name: 'Preview changes' }));
  expect(
    await screen.findByRole('button', {
      name: 'Apply documents without conflicts',
    }),
  ).toBeDisabled();
  expect(writes).toHaveLength(1);
});
it('applies safe documents while keeping remaining conflicts visible instead of reporting full success', async () => {
  conflict = true;
  partial = true;
  const user = userEvent.setup();
  fixture.render(
    <GitDeliverablesSettings projectId="p" preferredCopyId="copy" />,
  );
  await user.click(await screen.findByRole('switch'));
  await user.click(screen.getByRole('button', { name: 'Preview changes' }));
  await user.click(
    await screen.findByRole('button', {
      name: 'Apply documents without conflicts',
    }),
  );
  expect(
    await screen.findByText(
      'Documents without conflicts were synchronized. The remaining differences are listed below for review; no automatic overwrite.',
    ),
  ).toBeVisible();
  expect(screen.getByText('Cadrage / notes.md')).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Apply documents without conflicts' }),
  ).toBeDisabled();
  expect(writes.filter((write) => write.url.endsWith('/apply'))).toHaveLength(
    1,
  );
});
it('recognizes a repository automatically without sending an import until requested', async () => {
  const user = userEvent.setup();
  fixture.render(<GitDeliverablesDiscovery projectId="p" copyId="copy" />);
  expect(
    await screen.findByText('One deliverable recognized in this repository.'),
  ).toBeVisible();
  expect(writes).toEqual([]);
  await user.click(
    screen.getByRole('button', { name: 'Review Git deliverables' }),
  );
  expect(await screen.findByRole('dialog')).toBeVisible();
  expect(writes).toEqual([]);
});

it('shows an explicit review notice for incoming Git changes without applying them', async () => {
  let head = 'base';
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        writes.push({
          url,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return Promise.resolve(json({ scheduled: true }));
      }
      return Promise.resolve(
        json({
          boards: [
            {
              id: 'board',
              name: 'Deliverables',
              restricted: [],
              settings: {
                enabled: true,
                directory: 'livrables',
                restrictedIds: [],
              },
            },
          ],
          copies: [{ id: 'copy', eligible: true }],
          discovered: [],
          discoveryError: null,
          proposal: {
            fingerprint: 'incoming',
            context: { branch: 'refs/heads/main', head },
            canApply: true,
            changes: [
              {
                deliverable: 'Report',
                document: 'report.md',
                action: 'import',
                reason: 'document',
              },
            ],
          },
        }),
      );
    }),
  );
  fixture.render(
    <GitDeliverablesDiscovery projectId="p" copyId="copy" inspectedAt={1} />,
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Git changes require your review',
  );
  expect(writes).toEqual([
    { url: '/api/projects/p/git-deliverables/reconcile', body: {} },
  ]);
  await fixture.queryClient.invalidateQueries({
    queryKey: ['git-deliverables', 'p'],
  });
  expect(writes).toHaveLength(1);
  head = 'pulled-commit';
  await fixture.queryClient.invalidateQueries({
    queryKey: ['git-deliverables', 'p'],
  });
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes.every((write) => write.url.endsWith('/reconcile'))).toBe(true);
});
