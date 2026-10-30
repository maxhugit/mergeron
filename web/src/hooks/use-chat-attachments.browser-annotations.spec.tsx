import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useEffect, useRef, useState } from 'react';
import { useChatAttachments } from './use-chat-attachments';
import { insertBrowserAnnotation } from '@/lib/browser-annotations';
import { useComposerDraftStore } from '@/stores/composer-draft-store';
vi.mock('@/auth-token', () => ({
  getAuthorizationHeader: () => undefined,
  clearApiToken: vi.fn(),
}));
const fetchMock = vi.fn();
beforeEach(() => {
  useComposerDraftStore.setState({ drafts: {}, forgotten: new Set() });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ path: '/tmp/test.png' }),
  });
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = () => 'blob:test';
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
function useDraft(threadId: string, readOnly: boolean) {
  const [value, setValue] = useState('Existing draft');
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachments = useChatAttachments({
    threadId,
    readOnly,
    textareaRef,
    valueRef,
    setValue,
    threadCwd: null,
    addSystemError: vi.fn(),
  });
  return { value, ...attachments };
}
it('preserves the draft and adds image plus annotation atomically, without starting a turn', async () => {
  const { result } = renderHook(() => useDraft('a', false));
  await act(async () =>
    insertBrowserAnnotation({
      threadId: 'a',
      text: '\nAnnotation',
      image: new File(['png'], 'browser.png', { type: 'image/png' }),
    }),
  );
  await waitFor(() => expect(result.current.attachments).toHaveLength(1));
  expect(result.current.value).toBe('Existing draft\nAnnotation');
  expect(fetchMock.mock.calls[0][0]).toContain('/api/chat/upload');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('accepts text-only native browser annotations without uploading or sending a turn', async () => {
  const { result } = renderHook(() => useDraft('a', false));
  await act(async () =>
    insertBrowserAnnotation({ threadId: 'a', text: '\nNative annotation' }),
  );
  expect(result.current.value).toBe('Existing draft\nNative annotation');
  expect(result.current.attachments).toHaveLength(0);
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each([
  ['b', false],
  ['a', true],
])(
  'rejects another conversation or a read-only composer',
  async (threadId, readOnly) => {
    const { result } = renderHook(() => useDraft(threadId, readOnly));
    await expect(
      insertBrowserAnnotation({
        threadId: 'a',
        text: 'Annotation',
        image: new File(['png'], 'browser.png'),
      }),
    ).rejects.toThrow('unavailable');
    expect(result.current.value).toBe('Existing draft');
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
