import { afterEach, expect, test } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { page } from 'vitest/browser';
import {
  DeliverablesList,
  DeliverableHistory,
  DeliverableLifecycleFlow,
  LifecycleActions,
} from './project-deliverables-manager';
import type { Deliverable, DeliverablesBoard } from '@/lib/deliverables-api';
import '@/index.css';
import i18n, { i18nReady } from '@/i18n';

afterEach(cleanup);
const item = {
  id: 'report',
  title: 'Dossier de conception',
  description: 'Description du livrable',
  lifecycleStatus: 'draft',
  validationStatus: 'not_required',
  validationRequired: false,
  confidentiality: 'restricted',
  primaryTaskId: null,
  updatedAt: Date.UTC(2026, 9, 25),
  documents: [
    { id: 'first', name: 'Dossier de conception.docx', deletedAt: null },
    {
      id: 'second',
      name: 'Présentation des choix de conception et des arbitrages.pptx',
      deletedAt: null,
    },
  ],
} as Deliverable;
const board = {
  tasks: [],
  resource: { projectId: 'project' },
} as unknown as DeliverablesBoard;

test.each([390, 800, 1001, 1280])(
  'keeps badges aligned and names responsive at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('en');
    render(
      <div style={{ width: '100%', padding: 16 }}>
        <DeliverablesList items={[item]} board={board} onSelect={() => {}} />
      </div>,
    );
    await waitFor(() =>
      expect(Boolean(screen.queryByRole('table'))).toBe(width >= 608),
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    if (width >= 608) {
      const table = screen.getByRole('table');
      expect(within(table).getAllByRole('columnheader')).toHaveLength(6);
      expect(within(table).getAllByRole('row')).toHaveLength(2);
      expect(
        within(table).getByText('Dossier de conception.docx'),
      ).toBeVisible();
      expect(
        within(table).getByRole('button', { name: /Actions/ }),
      ).toBeVisible();
      return;
    }
    const status = screen.getByTestId('deliverable-status-report');
    const row = status.parentElement!;
    const badgeElements = Array.from(row.children).filter((element) =>
      element.classList.contains('justify-self-end'),
    );
    const bounds = badgeElements.map((element) =>
      element.getBoundingClientRect(),
    );
    expect(bounds).toHaveLength(3);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const names = row.querySelector('ul')!;
    if (width < 576) expect(getComputedStyle(names).display).toBe('none');
    else expect(getComputedStyle(names).display).not.toBe('none');
    if (width < 1120) {
      expect(Math.abs(bounds[0].right - bounds[1].right)).toBeLessThan(1);
      expect(Math.abs(bounds[1].right - bounds[2].right)).toBeLessThan(1);
      expect(bounds[0].top).toBeLessThan(bounds[1].top);
      expect(bounds[1].top).toBeLessThan(bounds[2].top);
    } else {
      expect(Math.abs(bounds[0].top - bounds[1].top)).toBeLessThan(1);
      expect(Math.abs(bounds[1].top - bounds[2].top)).toBeLessThan(1);
    }
  },
);

test('opens the selected section and dismisses row actions with Escape or an outside click', async () => {
  await page.viewport(1001, 900);
  await i18nReady;
  await i18n.changeLanguage('en');
  const selected: Array<[string, string | undefined]> = [];
  render(
    <div style={{ padding: 16 }}>
      <button>Outside</button>
      <DeliverablesList
        items={[item]}
        board={board}
        onSelect={(id, tab) => selected.push([id, tab])}
      />
    </div>,
  );
  await screen.findByRole('table');
  await page.getByRole('button', { name: /Actions/ }).click();
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  expect(selected).toEqual([['report', 'documents']]);
  expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
  await page.getByRole('button', { name: /Actions/ }).click();
  const history = await screen.findByRole('button', { name: 'History' });
  fireEvent.keyDown(history, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull(),
  );
  await page.getByRole('button', { name: /Actions/ }).click();
  await page.getByRole('button', { name: 'Outside', exact: true }).click();
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull(),
  );
});

test('translates history headings and lifecycle events in French across namespaces', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  render(
    <DeliverableHistory
      item={
        {
          ...item,
          documents: [],
          versions: [],
          validations: [],
          validationEvents: [
            {
              id: 'enabled',
              validationId: null,
              deliverableId: item.id,
              actorPersonId: null,
              reason: null,
              action: 'enabled',
              createdAt: 2,
              actorName: 'Maxime',
            },
          ],
          lifecycleEvents: [
            {
              id: 'life',
              deliverableId: item.id,
              snapshotId: null,
              actorPersonId: null,
              fromStatus: 'draft',
              toStatus: 'in_constitution',
              createdAt: 1,
              actorName: 'Maxime',
            },
          ],
        } as Deliverable
      }
      download={async () => {}}
    />,
  );
  const table = screen.getByRole('table', { name: 'Historique' });
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent),
  ).toEqual(['Date', 'Auteur', 'Historique']);
  expect(within(table).getByText('Brouillon → En constitution')).toBeVisible();
  expect(within(table).getByText('Validation activée')).toBeVisible();
});

test.each([390, 1001])(
  'keeps the chevron lifecycle inside the viewport and exposes definitions at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    await i18n.changeLanguage('fr');
    render(
      <div style={{ padding: 16 }}>
        <DeliverableLifecycleFlow
          item={{ ...item, validationRequired: true }}
        />
      </div>,
    );
    const flow = screen.getByRole('region', {
      name: 'Cycle de vie du livrable et de ses documents',
    });
    expect(within(flow).queryByRole('heading')).toBeNull();
    expect(flow.classList.contains('border')).toBe(false);
    expect(flow.classList.contains('bg-card')).toBe(false);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const list = within(flow).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(
      getComputedStyle(within(list).getAllByRole('listitem')[0]).clipPath,
    ).toContain('polygon');
    expect(
      Math.abs(
        list.getBoundingClientRect().width - flow.getBoundingClientRect().width,
      ),
    ).toBeLessThan(1);
    await page.getByText('Brouillon', { exact: true }).hover();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Le livrable est en cours de définition',
    );
  },
);

test('uses the selected theme for current, completed and upcoming lifecycle chevrons', async () => {
  await i18nReady;
  const root = document.documentElement;
  const previousTheme = root.getAttribute('data-theme');
  const previousClass = root.className;
  render(
    <DeliverableLifecycleFlow
      item={{
        ...item,
        lifecycleStatus: 'in_constitution',
        validationRequired: true,
      }}
    />,
  );
  const states = ['complete', 'current', 'upcoming'];
  const chevrons = states.map(
    (state) =>
      document.querySelector(
        `[data-stage-state="${state}"] > span`,
      ) as HTMLElement,
  );
  const probe = document.createElement('span');
  probe.style.backgroundColor = 'var(--primary)';
  probe.style.color = 'var(--primary-foreground)';
  document.body.append(probe);
  const palettes = new Set<string>();
  try {
    for (const theme of [
      'light',
      'dark',
      'sepia',
      'nord',
      'solarized',
      'dracula',
      'high-contrast',
    ]) {
      root.setAttribute('data-theme', theme);
      root.classList.toggle('dark', theme === 'dark');
      const expected = getComputedStyle(probe);
      const primary = expected.backgroundColor;
      const foreground = expected.color;
      await waitFor(() => {
        expect(getComputedStyle(chevrons[1]).backgroundColor).toBe(primary);
        expect(getComputedStyle(chevrons[1]).color).toBe(foreground);
        expect(
          getComputedStyle(chevrons[0].firstElementChild!).backgroundColor,
        ).toBe(primary);
        expect(getComputedStyle(chevrons[0].firstElementChild!).color).toBe(
          foreground,
        );
      });
      const colors = chevrons.map(
        (element) => getComputedStyle(element).backgroundColor,
      );
      expect(new Set(colors).size).toBe(3);
      palettes.add(colors.join('|'));
    }
    expect(palettes.size).toBe(7);
  } finally {
    probe.remove();
    root.className = previousClass;
    if (previousTheme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', previousTheme);
  }
});

test('keeps status transitions in the application dropdown and sends only the selected action', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  const calls: unknown[] = [];
  render(
    <LifecycleActions
      item={{ ...item, version: 3 }}
      busy={false}
      action={{ mutate: (input) => calls.push(input) }}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Finaliser' })).toBeNull();
  await page
    .getByRole('button', { name: 'Changement de statut', exact: true })
    .click();
  expect(screen.getByRole('button', { name: 'Finaliser' })).toBeVisible();
  expect(calls).toHaveLength(0);
  await page
    .getByRole('button', { name: 'Commencer la constitution', exact: true })
    .click();
  expect(calls).toEqual([
    { suffix: '/lifecycle', body: { target: 'in_constitution', version: 3 } },
  ]);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Finaliser' })).toBeNull(),
  );
});
