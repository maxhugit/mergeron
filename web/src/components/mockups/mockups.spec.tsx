import { expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, fireEvent, screen } from '@testing-library/react';
import {
  mockupReference,
  presentedMockup,
  parseMockupDocument,
} from '@/lib/mockups';
import { useWorkspaceStore } from '@/stores/workspace-store';
import {
  normalizeThreadItem,
  mergeTurnItem,
} from '@/lib/thread-item-normalizer';
import { MockupPanel } from './mockup-panel';
import { MockupCard } from './mockup-card';
import { validMockupMessage, mockupSource } from '@/lib/mockup-sandbox';
const reference = {
  type: 'mergeron.mockup' as const,
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  revision: '33333333-3333-4333-8333-333333333333',
  threadId: 'thread-1',
  title: 'Simulated checkout',
  number: 1,
};
it('accepts a bounded structured reference only from the internal presentation tool', () => {
  expect(
    presentedMockup('mergeron_internal', 'project_mockup_report', {
      structuredContent: { reference },
    }),
  ).toEqual(reference);
  expect(
    presentedMockup('foreign', 'project_mockup_report', {
      structuredContent: { reference },
    }),
  ).toBeUndefined();
  expect(
    presentedMockup('mergeron_internal', 'project_mockup_read', {
      structuredContent: { reference },
    }),
  ).toBeUndefined();
  expect(
    presentedMockup('mergeron_internal', 'project_mockup_report', {
      content: [{ type: 'text', text: JSON.stringify({ reference }) }],
    }),
  ).toEqual(reference);
  expect(mockupReference({ ...reference, id: '../../files' })).toBeUndefined();
  expect(
    mockupReference({ ...reference, title: 'x'.repeat(161) }),
  ).toBeUndefined();
});
it('opens and reuses a sibling workspace tab without changing the conversation', () => {
  useWorkspaceStore.setState({ contexts: {} });
  render(<MockupCard reference={reference} threadId="thread-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open mockup' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open mockup' }));
  const workspace = useWorkspaceStore.getState().contexts['thread:thread-1'];
  expect(workspace.tabs).toHaveLength(1);
  expect(workspace.tabs[0]).toMatchObject({ kind: 'mockup', reference });
  expect(workspace.activeId).toBe(workspace.tabs[0].id);
  useWorkspaceStore.getState().select('thread:thread-1', 'conversation');
  expect(
    useWorkspaceStore.getState().contexts['thread:thread-1'].tabs,
  ).toHaveLength(1);
});
it('refuses messages from other windows, stale sessions and unbounded or action-bearing schemas', () => {
  const source = {} as Window;
  const data = {
    type: 'mergeron.mockup.error',
    session: 'current',
    message: 'scriptError',
  };
  const event = (patch: Record<string, unknown> = {}) =>
    ({ source, origin: 'null', data, ...patch }) as MessageEvent;
  expect(validMockupMessage(event(), source, 'current')).toBe(true);
  for (const patch of [
    { source: {} },
    { origin: location.origin },
    { data: { ...data, session: 'old' } },
    { data: { ...data, action: 'executeTool' } },
    { data: { ...data, message: 'x'.repeat(100000) } },
    { data: null },
  ])
    expect(validMockupMessage(event(patch), source, 'current')).toBe(false);
  expect(validMockupMessage(event(), null, 'current')).toBe(false);
});
it('places restrictive CSP and the error bridge before all untrusted HTML', () => {
  const source = mockupSource(
    '<script>throw Error("test")</script>',
    'channel',
  );
  expect(source.indexOf('Content-Security-Policy')).toBeLessThan(
    source.indexOf('throw Error'),
  );
  expect(source).toContain("connect-src 'none'");
  expect(source).toContain("form-action 'none'");
  expect(source).toContain("base-uri 'none'");
});

it('restores the structured card from persisted MCP history after a reload', () => {
  const saved = JSON.parse(
    JSON.stringify({
      id: 'tool',
      type: 'mcpToolCall',
      server: 'mergeron_internal',
      tool: 'project_mockup_report',
      status: 'completed',
      arguments: { id: reference.id },
      result: {
        content: [{ type: 'text', text: JSON.stringify({ reference }) }],
        structuredContent: { reference },
      },
    }),
  );
  expect(normalizeThreadItem(saved, true)).toMatchObject({
    kind: 'render',
    item: { mockupReference: reference },
  });
});

it('preserves a previously verified reference through later partial protocol updates', () => {
  const old = {
    type: 'mcpToolCall' as const,
    itemId: 'tool',
    completed: true,
    toolName: 'project_mockup_report',
    toolServer: 'mergeron_internal',
    toolArgs: '{}',
    content: 'result',
    mockupReference: reference,
  };
  expect(
    mergeTurnItem(old, { ...old, content: '', mockupReference: undefined }),
  ).toMatchObject({ mockupReference: reference });
});

it('rejects login and malformed source responses instead of crashing the workspace', () => {
  const valid = {
    reference,
    html: '<button>Simulation</button>',
    currentRevision: reference.revision,
    history: [
      {
        id: reference.revision,
        number: 1,
        title: reference.title,
        authorName: 'Agent',
        createdAt: 1,
      },
    ],
  };
  expect(parseMockupDocument(valid, reference)).toEqual(valid);
  for (const response of [
    '<html>Sign in</html>',
    {},
    null,
    { ...valid, reference: { ...reference, threadId: 'foreign' } },
    { ...valid, history: [null] },
    { ...valid, history: [] },
    { ...valid, html: { unsafe: 'not a document' } },
    { ...valid, currentRevision: 'invalid' },
  ])
    expect(() => parseMockupDocument(response, reference)).toThrow(
      'Invalid mockup response',
    );
});

it('reopens the revision pinned in the message after browsing another version', () => {
  const query = new QueryClient();
  const second = {
    ...reference,
    revision: '44444444-4444-4444-8444-444444444444',
    number: 2,
    title: 'Second revision',
  };
  const history = [reference, second].map((ref) => ({
    id: ref.revision,
    number: ref.number,
    title: ref.title,
    authorName: 'Agent',
    createdAt: 1,
  }));
  for (const ref of [reference, second])
    query.setQueryData(
      ['mockup', ref.projectId, ref.threadId, ref.id, ref.revision],
      {
        reference: ref,
        html: `<p>Source version ${ref.number}</p>`,
        currentRevision: second.revision,
        history,
      },
    );
  const view = (active: boolean) => (
    <QueryClientProvider client={query}>
      <MockupPanel reference={reference} active={active} />
    </QueryClientProvider>
  );
  const mounted = render(view(true));
  fireEvent.change(screen.getByRole('combobox', { name: 'Revision' }), {
    target: { value: second.revision },
  });
  expect(screen.getByRole('combobox', { name: 'Revision' })).toHaveValue(
    second.revision,
  );
  mounted.rerender(view(false));
  mounted.rerender(view(true));
  expect(screen.getByRole('combobox', { name: 'Revision' })).toHaveValue(
    reference.revision,
  );
  expect(screen.getByTitle(reference.title).getAttribute('srcdoc')).toContain(
    'Source version 1',
  );
  mounted.unmount();
  query.clear();
});
