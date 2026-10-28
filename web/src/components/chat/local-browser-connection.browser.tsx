/** Real layout + composer integration: connection UI must never become a split browser view. */
import { useEffect, useRef, useState } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { LocalBrowserSidebar } from './local-browser-sidebar';
import { WorkspaceControls } from './workspace-controls';
import { useChatAttachments } from '@/hooks/use-chat-attachments';
import { i18nReady } from '@/i18n';
import i18n from '@/i18n';
import '@/index.css';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  extension: vi.fn(),
  annotation: false,
}));
vi.mock('@/lib/local-browser-api', () => ({
  localBrowserApi: mocks.api,
  extensionRequest: mocks.extension,
}));
vi.mock('@/auth-token', () => ({
  getAuthorizationHeader: () => undefined,
  clearApiToken: vi.fn(),
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }),
}));

export function Fixture() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('Existing message');
  const [status, setStatus] = useState('disconnected');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const { chipAttachments } = useChatAttachments({
    threadId: 'agent',
    readOnly: false,
    textareaRef,
    valueRef,
    setValue,
    threadCwd: null,
    addSystemError: vi.fn(),
  });
  return (
    <main style={{ width: '100%', maxWidth: 900 }}>
      <WorkspaceControls
        workspace={{ tabs: [], activeId: 'conversation' }}
        running={false}
        pending={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onExplorer={vi.fn()}
        onNewTerminal={vi.fn()}
        onLocalBrowser={() => setOpen(true)}
        localBrowserStatus={status}
      />
      <textarea
        aria-label="Message"
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ width: '100%' }}
      />
      <p data-testid="attachments">{chipAttachments.length}</p>
      <LocalBrowserSidebar
        threadId="agent"
        open={open}
        onOpenChange={setOpen}
        onStatusChange={setStatus}
        onAnnotationAdded={() => setOpen(false)}
      />
    </main>
  );
}

beforeEach(async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
  mocks.annotation = false;
  mocks.api
    .mockReset()
    .mockImplementation((_thread, path) =>
      Promise.resolve(
        path === 'open' ? { id: 'session' } : { approvals: [], dispatch: [] },
      ),
    );
  mocks.extension.mockReset().mockImplementation((action) =>
    Promise.resolve(
      action === 'state'
        ? {
            state: 'shared',
            epoch: 'e',
            ...(mocks.annotation
              ? { annotation: { id: 'capture', text: '' } }
              : {}),
          }
        : action === 'annotation'
          ? {
              id: 'capture',
              comment: '',
              image: 'data:image/jpeg;base64,/9j/AA==',
              selection: {
                text: 'Save',
                tag: 'button',
                url: 'https://fixture.invalid',
              },
            }
          : { ok: true },
    ),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ path: '/fixture/capture.jpg' }),
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each([
  [1280, 900],
  [390, 844],
])(
  'compact association keeps full-width composer at %s px, and closing it preserves annotation delivery',
  async (width, height) => {
    const view = render(<Fixture />);
    await page.viewport(width, height);
    await waitFor(() =>
      expect(screen.queryAllByRole('tab')).toHaveLength(width > 1000 ? 1 : 0),
    );
    const input = screen.getByRole('textbox', { name: 'Message' });
    const originalWidth = input.getBoundingClientRect().width;
    expect(originalWidth).toBeGreaterThan(300);
    fireEvent.click(
      screen.getByRole('button', { name: 'Extension connection' }),
    );
    expect(
      screen.getByRole('dialog').getBoundingClientRect().width,
    ).toBeLessThanOrEqual(width);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Pair the extension with this agent',
      }),
    );
    await screen.findByText('Tab shared with this agent', { selector: 'p' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(input.getBoundingClientRect().width).toBeCloseTo(originalWidth, 0);
    expect(screen.queryAllByRole('tab')).toHaveLength(width > 1000 ? 1 : 0);
    expect(
      mocks.extension.mock.calls.some(([action]) => action === 'revoke'),
    ).toBe(false);
    mocks.annotation = true;
    await waitFor(
      () => expect((input as HTMLTextAreaElement).value).toContain('Save'),
      { timeout: 4000 },
    );
    expect((input as HTMLTextAreaElement).value).toContain('Existing message');
    expect(screen.getByTestId('attachments').textContent).toBe('1');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.extension).toHaveBeenCalledWith('annotationAck', {
      sessionId: 'session',
      annotationId: 'capture',
    });
    expect(fetch).toHaveBeenCalledTimes(1); // upload only, no chat turn
    view.unmount();
    expect(mocks.extension).toHaveBeenCalledWith('revoke', {
      sessionId: 'session',
    });
  },
);
