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
          version: '1.0.0',
          transport: 'Streamable HTTP',
        },
        instructions: 'Only explicit human requests authorize creation.',
        protocolMethods: ['initialize', 'tools/list', 'tools/call'],
        limits: { turnCalls: 100 },
        errors: ['READ_ONLY'],
        tools: [
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
  for (const width of [1000, 390]) {
    await page.viewport(width, 800);
    expect(screen.getByRole('table')).toBeVisible();
    expect(screen.getByText('requestId')).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  }
  client.clear();
});
