import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  forgetPresentations,
  presentationState,
  presentationKey,
  readPresentation,
  writePresentation,
} from '@/lib/mockup-presentation';
import { readMockupMessage, mockupSource } from '@/lib/mockup-sandbox';
import { RememberedMockupFrame } from './remembered-mockup-frame';
const reference = {
  type: 'mergeron.mockup' as const,
  projectId: '22222222-2222-4222-8222-222222222222',
  threadId: 'thread',
  id: '11111111-1111-4111-8111-111111111111',
  revision: '33333333-3333-4333-8333-333333333333',
  number: 1,
  title: 'Presentation',
};
afterEach(() => {
  localStorage.removeItem('mergeron.mockup.presentation.v1');
  vi.restoreAllMocks();
});
it('bounds presentation shape, bytes, depth and prototype-sensitive keys', () => {
  expect(
    presentationState({ tab: 'board', expanded: [true, false], count: 2 }),
  ).toBeDefined();
  const deep = { a: { a: { a: { a: { a: { a: { a: 1 } } } } } } };
  for (const value of [
    null,
    [],
    { text: 'x'.repeat(257) },
    deep,
    { values: Array(41).fill(1) },
    JSON.parse('{"__proto__":{"x":1}}'),
    Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => ['k' + i, 'é'.repeat(100)]),
    ),
  ])
    expect(presentationState(value)).toBeUndefined();
});
it('separates opt-in preferences by identity and revision, expires them and bounds retention', () => {
  const key = presentationKey('person-a', 'p', 't', 'm', 'r1');
  expect(readPresentation(key, 100)).toEqual({ enabled: false, state: null });
  expect(writePresentation(key, { tab: 'board' }, true, 100)).toBe(true);
  expect(readPresentation(key, 101).state).toEqual({ tab: 'board' });
  expect(
    readPresentation(presentationKey('person-b', 'p', 't', 'm', 'r1'), 101)
      .enabled,
  ).toBe(false);
  expect(
    readPresentation(presentationKey('person-a', 'p', 't', 'm', 'r2'), 101)
      .enabled,
  ).toBe(false);
  expect(readPresentation(key, 100 + 31 * 86400000).enabled).toBe(false);
  for (let i = 0; i < 21; i++)
    writePresentation('key-' + i, { selected: i }, true, 100 + i);
  expect(readPresentation('key-0', 121).enabled).toBe(false);
  expect(readPresentation('key-20', 121).enabled).toBe(true);
  writePresentation('key-20', null, false, 121);
  expect(readPresentation('key-20', 121).enabled).toBe(false);
});
it('validates the exact frame, nonce and bounded JSON before accepting presentation data', () => {
  const source = {} as Window;
  const event = (patch: Record<string, unknown> = {}) =>
    ({
      source,
      origin: 'null',
      data: {
        type: 'mergeron.mockup.presentation',
        session: 'nonce',
        value: '{"tab":"board"}',
      },
      ...patch,
    }) as MessageEvent;
  expect(readMockupMessage(event(), source, 'nonce')).toEqual({
    kind: 'presentation',
    state: { tab: 'board' },
  });
  for (const change of [
    { source: {} },
    { origin: location.origin },
    {
      data: {
        type: 'mergeron.mockup.presentation',
        session: 'old',
        value: '{}',
      },
    },
    {
      data: {
        type: 'mergeron.mockup.presentation',
        session: 'nonce',
        value: 'x'.repeat(4097),
      },
    },
    {
      data: {
        type: 'mergeron.mockup.presentation',
        session: 'nonce',
        value: '{}',
        action: 'callServer',
      },
    },
  ])
    expect(readMockupMessage(event(change), source, 'nonce')).toBeUndefined();
  const html = mockupSource('<h1>Simulation</h1>', 'nonce', {
    tab: '</script><script>STATE_ESCAPE</script>',
  });
  expect(html).not.toContain('</script><script>STATE_ESCAPE');
  const encoded = /let state=(.*?);const session=/.exec(html)![1];
  expect(JSON.parse(encoded)).toEqual({
    tab: '</script><script>STATE_ESCAPE</script>',
  });
});
it('stores only after human opt-in, restores local choices and forgets on disable without any server call', () => {
  const network = vi.spyOn(globalThis, 'fetch');
  const key = presentationKey(
    'person-a',
    reference.projectId,
    reference.threadId,
    reference.id,
    reference.revision,
  );
  const emit = (value: unknown) => {
    const frame = screen.getByTitle(reference.title) as HTMLIFrameElement;
    const src = frame.getAttribute('srcdoc')!;
    const nonce = /const session="([^"]+)"/.exec(src)![1];
    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'null',
        data: {
          type: 'mergeron.mockup.presentation',
          session: nonce,
          value: JSON.stringify(value),
        },
      }),
    );
  };
  const ui = () => (
    <div style={{ height: 300 }}>
      <RememberedMockupFrame
        reference={reference}
        owner="person-a"
        html="<h1>Simulation</h1>"
      />
    </div>
  );
  const first = render(ui());
  emit({ tab: 'board' });
  expect(readPresentation(key).enabled).toBe(false);
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Remember choices on this device' }),
  );
  emit({ tab: 'details' });
  expect(readPresentation(key).state).toEqual({ tab: 'details' });
  first.unmount();
  render(ui());
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.getByTitle(reference.title).getAttribute('srcdoc')).toContain(
    '"tab":"details"',
  );
  fireEvent.click(screen.getByRole('checkbox'));
  expect(readPresentation(key).enabled).toBe(false);
  expect(network).not.toHaveBeenCalled();
});

it('removes presentation preferences on known project or conversation deletion only', () => {
  const a = presentationKey('a', 'project-one', 'thread-one', 'm', 'r');
  const b = presentationKey('a', 'project-two', 'thread-two', 'm', 'r');
  writePresentation(a, { tab: 'one' }, true);
  writePresentation(b, { tab: 'two' }, true);
  forgetPresentations({ threadIds: ['thread-one'] });
  expect(readPresentation(a).enabled).toBe(false);
  expect(readPresentation(b).enabled).toBe(true);
  forgetPresentations({ projectId: 'project-two' });
  expect(readPresentation(b).enabled).toBe(false);
});
