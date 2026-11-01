import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { InternalMcpSettings } from './internal-mcp-settings';
import type { InternalMcpCatalog } from './internal-mcp-api';

const catalog: InternalMcpCatalog = {
  server: {
    name: 'mergeron_internal',
    version: '1.8.0',
    transport: 'Streamable HTTP',
    exposure: 'loopback-only',
    authentication: 'conversation-bound',
  },
  instructions: 'Create only on explicit human request.',
  protocolMethods: ['initialize', 'tools/list', 'tools/call'],
  limits: { pageSize: 50 },
  errors: ['READ_ONLY'],
  tools: [
    {
      name: 'project_get',
      title: 'Project — Read the project',
      titleFr: 'Projet — Consulter le projet',
      aliases: ['get_project'],
      description: 'Read the project.',
      descriptionFr: 'Consulter le projet.',
      readOnly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'object' },
      example: {},
    },
    {
      name: 'project_task_create',
      title: 'Tasks — Create a task',
      titleFr: 'Tâches — Créer une tâche',
      aliases: ['create_task'],
      description: 'Create a task on request.',
      descriptionFr: 'Créer une tâche sur demande.',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string', maxLength: 100 },
          title: { type: 'string', maxLength: 200 },
        },
        required: ['requestId', 'title'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { status: { type: 'string', const: 'created' } },
      },
      example: { requestId: 'task-1', title: 'Presentation' },
    },
  ],
};
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
function page() {
  return render(
    <QueryClientProvider client={client}>
      <InternalMcpSettings />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => catalog });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

describe('internal MCP documentation', () => {
  it('shows a searchable native MCP reference without executing tools or exposing credentials', async () => {
    page();
    expect(await screen.findByText('2 methods')).toBeVisible();
    expect(screen.getByText('mergeron_internal')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search methods' }), {
      target: { value: 'project_task_create' },
    });
    expect(screen.queryByText('project_get')).toBeNull();
    expect(screen.getByText('1 method')).toBeVisible();
    const details = screen.getByText('project_task_create').closest('details')!;
    fireEvent.click(screen.getByText('project_task_create'));
    expect(within(details).getByText('requestId')).toBeVisible();
    expect(
      within(details).getByText('Input schema (JSON Schema)'),
    ).toBeVisible();
    expect(
      within(details).getByText('Output schema (JSON Schema)'),
    ).toBeVisible();
    expect(within(details).getByText('MCP call example')).toBeVisible();
    expect(within(details).getByText(/"maxLength": 200/)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/internal-mcp/catalog');
    expect(JSON.stringify(catalog)).not.toContain('Bearer ');
  });

  it('renders French labels, descriptions and the empty-search state', async () => {
    await i18n.changeLanguage('fr');
    page();
    expect(await screen.findByText('MCP interne')).toBeVisible();
    expect(screen.getByText('Projet — Consulter le projet')).toBeVisible();
    fireEvent.click(screen.getByText('project_get'));
    expect(screen.getByText('Consulter le projet.')).toBeVisible();
    expect(screen.getByText('Aucun paramètre.')).toBeVisible();
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Rechercher une méthode' }),
      { target: { value: 'unknown-method' } },
    );
    expect(
      screen.getByText('Aucune méthode ne correspond à cette recherche.'),
    ).toBeVisible();
  });

  it('handles a denied catalog and allows a read-only retry', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    page();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot load the internal MCP catalog',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('2 methods')).toBeVisible();
  });

  it('finds canonical tools by legacy name or localized title without duplicate entries', async () => {
    await i18n.changeLanguage('fr');
    page();
    await screen.findByText('project_task_create');
    const search = screen.getByRole('textbox', {
      name: 'Rechercher une méthode',
    });
    for (const value of ['create_task', 'Tâches — Créer']) {
      fireEvent.change(search, { target: { value } });
      expect(screen.getByText('1 méthode')).toBeVisible();
      expect(screen.getAllByText('project_task_create')).toHaveLength(1);
      expect(screen.queryByText('project_get')).toBeNull();
    }
    fireEvent.click(
      screen.getByText('project_task_create').closest('summary')!,
    );
    expect(screen.getByText('create_task')).toBeVisible();
    expect(
      screen.getByText('Anciens noms toujours acceptés pour compatibilité :'),
    ).toBeVisible();
  });
});
