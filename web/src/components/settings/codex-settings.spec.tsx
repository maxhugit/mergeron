/** The raw repair editor must survive structured config failure and restart invalidation. */
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexSettings } from './codex-settings';
import { useAccountStore } from '@/stores/account-store';
import { accountReadAccountQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import { catalogFixture, deferred, json } from './catalog/catalog.testing';
import { codexConfigReadConfigQueryKey } from '@/generated/api/@tanstack/react-query.gen';

vi.mock('@monaco-editor/react', async () => ({
  default: (await import('./catalog/catalog.testing')).TextEditor,
}));
vi.mock('@/stores/theme-store', () => ({
  useThemeStore: (select: (state: { dark: boolean }) => unknown) =>
    select({ dark: false }),
}));

let fixture: ReturnType<typeof catalogFixture>;
async function renderModel() {
  fixture.render(<CodexSettings />);
  const tab = screen.getByRole('tab', { name: 'Model' });
  await waitFor(() => expect(tab).toBeEnabled());
  fireEvent.click(tab);
}

it('puts Account first, disables other tabs without a connection and responds to login/logout without reloading', async () => {
  const connected = useAccountStore.getState().account!;
  const disconnected = { ...connected, account: null };
  fixture.server.overrides.set('GET /api/account', () => json(disconnected));
  fixture.queryClient.setQueryData(accountReadAccountQueryKey(), disconnected);
  useAccountStore.getState().setAccount(disconnected);
  fixture.render(<CodexSettings />);
  const tabs = screen.getAllByRole('tab');
  expect(tabs[0]).toHaveTextContent('Account');
  expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  expect(tabs[1]).toHaveTextContent('Codex CLI');
  expect(tabs[1]).toBeEnabled();
  for (const tab of tabs.slice(2)) {
    if (
      ['Chat and Audio', 'Instructions', 'Integrations'].includes(
        tab.textContent ?? '',
      )
    )
      expect(tab).toBeEnabled();
    else expect(tab).toBeDisabled();
  }
  expect(
    screen.queryByRole('heading', { name: 'Model catalog' }),
  ).not.toBeInTheDocument();
  fixture.server.overrides.set('GET /api/account', () => json(connected));
  act(() => {
    fixture.queryClient.setQueryData(accountReadAccountQueryKey(), connected);
    useAccountStore.getState().setAccount(connected);
  });
  const model = screen.getByRole('tab', { name: 'Model' });
  await waitFor(() => expect(model).toBeEnabled());
  fireEvent.click(model);
  expect(screen.getByRole('heading', { name: 'Model catalog' })).toBeVisible();
  fixture.server.overrides.set('GET /api/account', () => json(disconnected));
  act(() =>
    useAccountStore
      .getState()
      .setAccountUpdated({ authMode: null, planType: null }),
  );
  expect(screen.getByRole('tab', { name: 'Account' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  for (const tab of screen.getAllByRole('tab').slice(2)) {
    if (
      ['Chat and Audio', 'Instructions', 'Integrations'].includes(
        tab.textContent ?? '',
      )
    )
      expect(tab).toBeEnabled();
    else expect(tab).toBeDisabled();
  }
});
it('can open CLI management even before an account is connected', async () => {
  const disconnected = { account: null, requiresOpenaiAuth: true };
  fixture.queryClient.setQueryData(accountReadAccountQueryKey(), disconnected);
  fixture.server.overrides.set('GET /api/account', () => json(disconnected));
  useAccountStore.getState().setAccount(null);
  fixture.render(<CodexSettings initialTab="cli" />);
  expect(screen.getByRole('tab', { name: 'Codex CLI' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(
    await screen.findByRole('heading', { name: 'Codex CLI on this server' }),
  ).toBeVisible();
});
beforeEach(() => {
  fixture = catalogFixture();
  fixture.server.overrides.set(
    'GET /api/settings/general.agentInstructions',
    () => json({ value: 'Common policy', defaultValue: 'Default policy' }),
  );
  const account = {
    account: { type: 'apiKey' as const },
    requiresOpenaiAuth: true,
    provider: {
      ok: true,
      id: 'openai',
      name: 'OpenAI',
      baseUrlMasked: null,
      envKey: null,
      envPresent: null,
    },
  };
  fixture.server.overrides.set('GET /api/account', () => json(account));
  fixture.queryClient.setQueryData(accountReadAccountQueryKey(), account);
  useAccountStore.getState().setAccount(account);
});
afterEach(() => {
  fixture.dispose();
  useAccountStore.getState().setAccount(null);
});

it('keeps common instructions editable without a Codex account or config and preserves drafts across tabs', async () => {
  const disconnected = {
    ...useAccountStore.getState().account,
    account: null,
    requiresOpenaiAuth: true,
  };
  fixture.queryClient.setQueryData(accountReadAccountQueryKey(), disconnected);
  fixture.server.overrides.set('GET /api/account', () => json(disconnected));
  useAccountStore.getState().setAccount(null);
  fixture.render(<CodexSettings />);
  fireEvent.click(screen.getByRole('tab', { name: 'Instructions' }));
  const editor = await screen.findByRole('textbox', {
    name: 'Common instructions text',
  });
  fireEvent.change(editor, { target: { value: 'Unsaved policy' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Account' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Instructions' }));
  expect(
    screen.getByRole('textbox', { name: 'Common instructions text' }),
  ).toHaveValue('Unsaved policy');
  expect(fixture.server.writes).toHaveLength(0);
});

it('preserves unsaved TOML through loading, failure and success, then exposes the required restart', async () => {
  const user = userEvent.setup();
  const config = deferred<Response>();
  const baseline = 'model = "example"\n';
  fixture.server.overrides.set('GET /api/codex/config', () => config.promise);
  fixture.server.overrides.set('GET /api/models', () =>
    json({ data: [], nextCursor: null }),
  );
  fixture.server.overrides.set('GET /api/codex/config/raw', () =>
    json({ content: baseline, filePath: 'config.toml' }),
  );
  fixture.server.overrides.set('PUT /api/codex/config/raw', () => {
    fixture.server.state = {
      ...fixture.server.state,
      configuredPointer: 'catalog-a.json',
      pointerApplied: false,
    };
    return json({ restartRequired: true, reloaded: false, warnings: [] });
  });
  await renderModel();
  expect(screen.getByRole('heading', { name: 'Model catalog' })).toBeVisible();
  await user.click(screen.getByRole('tab', { name: 'Raw configuration' }));
  await user.click(screen.getByRole('button', { name: 'Edit config.toml' }));
  const raw = await screen.findByRole('textbox', { name: 'Raw TOML' });
  await waitFor(() => expect(raw).toHaveValue(baseline));
  const edited = 'model = "edited"\n';
  fireEvent.change(raw, { target: { value: edited } });
  await act(async () => config.resolve(json({ message: 'Broken TOML' }, 503)));
  expect(raw).toHaveValue(edited);
  fixture.server.overrides.set('GET /api/codex/config', () =>
    json({ config: {}, origins: {} }),
  );
  await act(() =>
    fixture.queryClient.invalidateQueries({
      queryKey: codexConfigReadConfigQueryKey(),
    }),
  );
  expect(
    screen.queryByText(
      'Manage Codex app-server settings. Changes are saved to user config.toml and hot-reloaded.',
    ),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Raw TOML' })).toHaveValue(edited);
  await user.click(screen.getByRole('button', { name: 'Save & Reload' }));
  await waitFor(() =>
    expect(fixture.server.writes).toContainEqual({
      method: 'PUT',
      path: '/api/codex/config/raw',
      body: { content: edited, expectedContent: baseline },
    }),
  );
  expect(screen.getByRole('textbox', { name: 'Raw TOML' })).toHaveValue(edited);
  await user.click(screen.getByRole('tab', { name: 'Model' }));
  expect(
    await screen.findByRole('button', { name: 'Restart Codex' }),
  ).toBeEnabled();
});

it('shows Codex setting groups as tabs instead of one long page', async () => {
  const user = userEvent.setup();
  fixture.server.overrides.set('GET /api/codex/config', () =>
    json({
      config: {
        model: 'gpt-test',
        instructions: 'Be concise',
      },
      origins: {},
    }),
  );
  fixture.server.overrides.set('GET /api/models', () =>
    json({ data: [], nextCursor: null }),
  );
  fixture.server.overrides.set('GET /api/codex/config/raw', () =>
    json({ content: '', filePath: 'config.toml' }),
  );

  await renderModel();

  expect(
    await screen.findByRole('tab', { name: 'Model', selected: true }),
  ).toBeVisible();
  const tablist = screen.getByRole('tablist', {
    name: 'Codex configuration sections',
  });
  expect(tablist.parentElement).toHaveClass('h-10', 'shrink-0', 'border-b');
  expect(tablist.closest('section')).toHaveClass(
    'flex',
    'min-h-0',
    'flex-1',
    'flex-col',
  );
  expect(await screen.findByText('Default model name')).toBeVisible();
  expect(
    screen.queryByRole('tab', { name: 'Catalog' }),
  ).not.toBeInTheDocument();
  const catalogHeading = screen.getByRole('heading', { name: 'Model catalog' });
  expect(
    catalogHeading.compareDocumentPosition(
      screen.getByText('Default model name'),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByRole('tabpanel').parentElement).toHaveClass(
    'flex-1',
    'overflow-y-auto',
  );
  expect(
    screen.queryByText(
      'Reserved for future use by Codex. Leave empty; use AGENTS.md for project guidance.',
    ),
  ).not.toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Instructions' }));

  expect(
    screen.getByRole('tab', { name: 'Instructions', selected: true }),
  ).toBeVisible();
  expect(
    screen.getByText(
      'Reserved for future use by Codex. Leave empty; use AGENTS.md for project guidance.',
    ),
  ).toBeVisible();
  expect(screen.queryByText('Default model name')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('heading', { name: 'Model catalog' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: 'Tools' })).not.toBeInTheDocument();
  expect(
    screen.queryByRole('tab', { name: 'Advanced' }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Reasoning' }));
  expect(screen.getByText('Web Search')).toBeVisible();
  expect(screen.getByText('Service Tier')).toBeVisible();
  expect(
    screen.getByText(/Processing priority and speed, not reasoning effort/),
  ).toBeVisible();
});

function editableConfig() {
  let config: Record<string, unknown> = {
    model: 'first',
    review_model: 'first',
    instructions: 'Original',
  };
  fixture.server.overrides.set('GET /api/codex/config', () =>
    json({ config, origins: {} }),
  );
  fixture.server.overrides.set('PATCH /api/codex/config', async (request) => {
    const { edits } = (await request.json()) as {
      edits: { keyPath: string; value: unknown }[];
    };
    config = {
      ...config,
      ...Object.fromEntries(edits.map((edit) => [edit.keyPath, edit.value])),
    };
    return json({ config, origins: {} });
  });
  fixture.server.overrides.set('GET /api/models', (request) => {
    const cursor = new URL(request.url).searchParams.get('cursor');
    return json({
      data: [
        {
          model: cursor ? 'new-model' : 'first',
          hidden: false,
          serviceTiers: [{ id: 'new-tier' }],
          supportedReasoningEfforts: [
            { reasoningEffort: 'high' },
            { reasoningEffort: 'ultra' },
          ],
          isDefault: !cursor,
        },
      ],
      nextCursor: cursor ? null : 'second-page',
    });
  });
}

it('loads live model pages and saves only the active tab in one request', async () => {
  editableConfig();
  const user = userEvent.setup();
  await renderModel();
  const model = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() =>
    expect(
      within(model).getByRole('option', { name: 'new-model' }),
    ).toBeInTheDocument(),
  );
  expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
  await user.selectOptions(model, 'new-model');
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Review Model' }),
    'new-model',
  );
  expect(fixture.server.writes).toHaveLength(0);
  await user.click(screen.getByRole('tab', { name: 'Instructions' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), {
    target: { value: 'Pending instructions' },
  });
  await user.click(screen.getByRole('tab', { name: 'Model' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(fixture.server.writes).toHaveLength(1));
  expect(fixture.server.writes[0].body).toEqual({
    edits: [
      { keyPath: 'model', value: 'new-model' },
      { keyPath: 'review_model', value: 'new-model' },
    ],
  });
  await user.click(screen.getByRole('tab', { name: 'Instructions' }));
  expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveValue(
    'Pending instructions',
  );
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveValue(
    'Original',
  );
});

it('keeps drafts on save failure and uses advertised reasoning choices', async () => {
  editableConfig();
  fixture.server.overrides.set('PATCH /api/codex/config', () =>
    json({ message: 'Cannot write' }, 500),
  );
  const user = userEvent.setup();
  await renderModel();
  const model = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() =>
    expect(
      within(model).getByRole('option', { name: 'new-model' }),
    ).toBeInTheDocument(),
  );
  await user.selectOptions(model, 'new-model');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled(),
  );
  expect(model).toHaveValue('new-model');
  await user.click(screen.getByRole('tab', { name: 'Reasoning' }));
  const effort = screen.getByRole('combobox', { name: 'Reasoning Effort' });
  expect(
    within(effort).getByRole('option', { name: 'ultra' }),
  ).toBeInTheDocument();
  expect(
    within(effort).queryByRole('option', { name: 'minimal' }),
  ).not.toBeInTheDocument();
});

it('stages security choices and discards them without a backend mutation', async () => {
  editableConfig();
  const user = userEvent.setup();
  await renderModel();
  await screen.findByRole('combobox', { name: 'Model' });
  await user.click(screen.getByRole('tab', { name: 'Security' }));
  const policy = screen.getAllByRole('combobox')[0];
  await user.selectOptions(policy, 'never');
  expect(policy).toHaveValue('never');
  expect(fixture.server.writes).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(policy).toHaveValue('on-request');
  expect(fixture.server.writes).toHaveLength(0);
});
