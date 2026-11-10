import { afterEach, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { useDeliverableGitStatus } from '@/hooks/use-deliverable-git-status';
import {
  DeliverableGitBanner,
  DeliverableGitBadge,
} from './explorer-deliverable-git-status';
import { projectsApi } from '@/lib/projects-api';
import type { Status } from '@/lib/git-deliverables-api';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { Button } from '@/components/ui/button';
import { PackagePlus, List, Tags } from 'lucide-react';
vi.mock('@/hooks/use-git-copy-live-updates', () => ({
  useGitCopyLiveUpdates: () => {},
}));
vi.mock('@/lib/projects-api', async (original) => ({
  ...(await original<typeof import('@/lib/projects-api')>()),
  projectsApi: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
export function Panel() {
  const sync = useDeliverableGitStatus('p', 'agent', 'source', 'revision');
  return (
    <div className="flex h-[700px] flex-col overflow-hidden rounded border bg-background text-foreground">
      <DeliverableGitBanner sync={sync} projectId="p" canManage={false}>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          aria-label="Nouveau livrable"
        >
          <PackagePlus className="h-4 w-4" />
        </Button>
        <div
          className="flex shrink-0 items-center border-l pl-1"
          role="group"
          aria-label="Présentation"
        >
          <Button
            size="icon"
            variant="secondary"
            className="h-8 w-8"
            aria-label="Liste des fichiers"
            aria-pressed="true"
          >
            <List className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label="Vue par étiquettes"
            aria-pressed="false"
          >
            <Tags className="h-4 w-4" />
          </Button>
        </div>
      </DeliverableGitBanner>
      <div
        role="region"
        aria-label="Synthetic deliverable list"
        className="min-h-0 flex-1 overflow-auto p-2"
      >
        {Array.from({ length: 24 }, (_, index) => (
          <div
            key={index}
            className="mb-2 flex items-center justify-between rounded border p-3 text-sm"
          >
            <span>Cadrage {index + 1}</span>
            <DeliverableGitBadge sync={sync} itemId={index === 0 ? 'a' : 'b'} />
          </div>
        ))}
      </div>
    </div>
  );
}
function status(): Status {
  return {
    boards: [
      {
        id: 'board',
        name: 'Livrables',
        restricted: [],
        settings: {
          enabled: true,
          directory: 'livrables',
          restrictedIds: [],
          lastError: null,
          lastSyncAt: 123,
        },
      },
    ],
    copies: [
      {
        id: 'copy',
        name: 'BBCC — copie Cadrage',
        sourceResourceId: 'source',
        ownerThreadIds: ['agent'],
        localPath: '/synthetic/copy',
        writable: true,
        owned: true,
        eligible: true,
        context: { branch: 'refs/heads/main', head: 'a' },
        lastError: 'GIT_DELIVERABLES_REVIEW_REQUIRED',
      },
      {
        id: 'foreign',
        name: 'Copie autre agent',
        ownerThreadIds: ['other'],
        writable: true,
        owned: true,
        eligible: true,
      },
    ],
    discovered: [],
    discoveryError: null,
    verifiedAt: Date.UTC(2026, 10, 9),
    proposal: {
      fingerprint: 'verified',
      canApply: false,
      context: { branch: 'refs/heads/main', head: 'a' },
      changes: [
        {
          deliverable: 'Cadrage 1',
          deliverableId: 'a',
          action: 'conflict',
          reason: 'document_changed_both',
        },
      ],
    },
  };
}
test.each([390, 1100])(
  'shows the selected copy and branch, internal scrolling, per-item state and read-only details at %ipx',
  async (width) => {
    await i18nReady;
    await i18n.changeLanguage('fr');
    await page.viewport(width, 900);
    vi.mocked(projectsApi).mockImplementation(
      async () => structuredClone(status()) as never,
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Panel />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('main')).toBeVisible());
    expect(
      screen.queryByRole('combobox', { name: 'Copie Git des livrables' }),
    ).toBeNull();
    expect(
      screen.queryByRole('option', { name: 'Copie autre agent' }),
    ).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'À examiner' })).toBeVisible(),
    );
    expect(screen.getAllByTitle('À jour localement').length).toBe(23);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const banner = screen.getByRole('region', {
      name: 'Synchronisation des livrables avec Git local',
    });
    const top = banner.getBoundingClientRect().top;
    const list = screen.getByRole('region', {
      name: 'Synthetic deliverable list',
    });
    list.scrollTop = list.scrollHeight;
    fireEvent.scroll(list);
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(banner.getBoundingClientRect().top).toBe(top);

    await page.screenshot({
      path: `../../../.vitest-screenshots/deliverables-git-status-${width}.png`,
    });
    fireEvent.click(
      screen.getByRole('button', { name: /^Examiner les livrables Git/ }),
    );
    expect(
      await screen.findByText(/ne signifie pas commité ni publié/),
    ).toBeVisible();
    expect(
      screen.getByText(/Organisation|Contenu modifié des deux côtés/),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Confirmer et synchroniser' }),
    ).toBeNull();
    client.clear();
  },
);
test('clears the old green state during refresh and shows a read failure without reusing cached success', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  const rejections: ((error: Error) => void)[] = [];
  let failing = false;
  vi.mocked(projectsApi).mockImplementation(async () => {
    if (failing)
      return await new Promise((_, reject) => {
        rejections.push(reject);
      });
    const value = status();
    value.proposal!.changes = [];
    return value as never;
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Panel />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: 'À jour localement' }),
    ).toBeVisible(),
  );
  const banner = screen.getByRole('region', {
    name: 'Synchronisation des livrables avec Git local',
  });
  const height = banner.getBoundingClientRect().height;
  expect(height).toBe(48);
  fireEvent.click(
    screen.getByRole('button', { name: /^Examiner les livrables Git/ }),
  );
  failing = true;
  fireEvent.click(
    screen.getByRole('button', { name: 'Vérifier la synchronisation locale' }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: 'Vérification en cours' }),
    ).toBeVisible(),
  );
  expect(
    screen.queryByRole('status', { name: 'À jour localement' }),
  ).toBeNull();
  await waitFor(() => expect(rejections.length).toBeGreaterThanOrEqual(2));
  rejections.forEach((reject) => reject(new Error('Synthetic read failure')));
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: 'Synchronisation indisponible' }),
    ).toBeVisible(),
  );
  expect(
    screen.queryByRole('status', { name: 'À jour localement' }),
  ).toBeNull();
  expect(banner.getBoundingClientRect().height).toBe(height);
  client.clear();
});

test('disabling the project mode discards the previously verified detail', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  let enabled = true;
  vi.mocked(projectsApi).mockImplementation(async () => {
    const value = status();
    value.boards[0].settings!.enabled = enabled;
    value.proposal!.changes = [];
    return value as never;
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Panel />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: 'À jour localement' }),
    ).toBeVisible(),
  );
  fireEvent.click(
    screen.getByRole('button', { name: /^Examiner les livrables Git/ }),
  );
  enabled = false;
  fireEvent.click(
    screen.getByRole('button', { name: 'Vérifier la synchronisation locale' }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: /^Examiner les livrables Git/ }),
    ).toBeNull(),
  );
  expect(
    screen.queryByRole('status', { name: 'À jour localement' }),
  ).toBeNull();
  client.clear();
});

test('switches owned copies without reusing the previous branch or another agent copy', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  const requests: string[] = [];
  vi.mocked(projectsApi).mockImplementation(async (url) => {
    requests.push(String(url));
    const value = status();
    value.copies.push({
      ...value.copies[0],
      id: 'second',
      name: 'Autre copie personnelle',
      sourceResourceId: 'second-source',
      context: { branch: 'refs/heads/feature/documents', head: 'b' },
    });
    value.proposal!.changes = [];
    if (String(url).includes('copyId=second'))
      value.proposal!.context = value.copies[2].context!;
    return value as never;
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Panel />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByText('main')).toBeVisible());
  fireEvent.click(
    screen.getByRole('button', { name: /^Examiner les livrables Git/ }),
  );
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Copie Git des livrables' }),
    { target: { value: 'second' } },
  );
  await waitFor(() =>
    expect(screen.getByText('feature/documents')).toBeVisible(),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: 'À jour localement' }),
    ).toBeVisible(),
  );
  expect(screen.queryByText('main')).toBeNull();
  expect(requests.some((request) => request.includes('copyId=second'))).toBe(
    true,
  );
  expect(requests.some((request) => request.includes('copyId=foreign'))).toBe(
    false,
  );
  client.clear();
});
