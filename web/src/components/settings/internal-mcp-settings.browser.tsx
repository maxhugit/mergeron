import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';
import { InternalMcpSettings } from './internal-mcp-settings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('keeps technical schemas readable on mobile and desktop without page overflow', async () => {
  await i18nReady;
  await i18n.changeLanguage('fr');
  const client = new QueryClient();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        server: {
          name: 'mergeron_internal',
          version: '1.2.0',
          transport: 'Streamable HTTP',
        },
        instructions: 'Only explicit human requests authorize creation.',
        protocolMethods: ['initialize', 'tools/list', 'tools/call'],
        limits: { turnCalls: 100 },
        errors: ['READ_ONLY'],
        tools: [
          {
            name: 'publish_project_git',
            title: 'Publish with Git',
            description: 'Push an observed commit on explicit request.',
            descriptionFr: 'Publier un commit observé sur demande explicite.',
            readOnly: false,
            inputSchema: {
              type: 'object',
              properties: {
                connectionId: { type: 'string', maxLength: 100 },
                expectedBranch: { type: 'string', maxLength: 200 },
                expectedHead: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
              },
              required: ['connectionId', 'expectedBranch', 'expectedHead'],
              additionalProperties: false,
            },
            outputSchema: {
              type: 'object',
              properties: {
                operation: { type: 'string' },
                data: { type: 'object' },
              },
            },
            example: {
              connectionId: 'git-project',
              expectedBranch: 'feature/example',
              expectedHead: 'a'.repeat(40),
            },
          },
          {
            name: 'create_deliverable',
            title: 'Create deliverable',
            description: 'Create a deliverable.',
            descriptionFr: 'Créer un livrable.',
            readOnly: false,
            inputSchema: {
              type: 'object',
              properties: {
                requestId: {
                  type: 'string',
                  pattern: '^[A-Za-z0-9_-]{1,100}$',
                  description: 'Stable identifier for retries.',
                },
                resourceId: { type: 'string', maxLength: 100 },
              },
              required: ['requestId', 'resourceId'],
              additionalProperties: false,
            },
            outputSchema: {
              type: 'object',
              properties: { status: { const: 'created' } },
            },
            example: { requestId: 'presentation-1', resourceId: 'manager-1' },
          },
        ],
      }),
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <main className="mx-auto w-full max-w-4xl p-4">
        <InternalMcpSettings />
      </main>
    </QueryClientProvider>,
  );
  const tool = await screen.findByText('create_deliverable');
  fireEvent.click(tool.closest('summary')!);
  await screen.findByText('Créer un livrable.');
  fireEvent.click(screen.getByText('publish_project_git').closest('summary')!);
  expect(screen.getAllByText('Modification')).toHaveLength(2);
  document.documentElement.classList.add('dark');
  for (const width of [1000, 390]) {
    await page.viewport(width, 800);
    expect(screen.getAllByRole('table')).toHaveLength(2);
    for (const table of screen.getAllByRole('table'))
      expect(table).toBeVisible();
    expect(screen.getByText('requestId')).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    if (width === 390) {
      const wrapper = screen.getAllByRole('table')[0].parentElement!;
      expect(wrapper.scrollWidth).toBeGreaterThan(wrapper.clientWidth);
      wrapper.scrollLeft = wrapper.scrollWidth;
      expect(wrapper.scrollLeft).toBeGreaterThan(0);
      wrapper.scrollLeft = 0;
    }
    await page.screenshot({
      path: `../../../.vitest-screenshots/project-git-mcp-${width}.png`,
    });
  }
  client.clear();
});
