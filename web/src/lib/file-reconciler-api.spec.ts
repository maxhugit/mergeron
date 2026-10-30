/** Exercise background probes through the real generated client and global error handler. */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { configureApiClient } from '@/api-client';
import { clearApiToken, setApiToken } from '@/auth-token';
import { filesGetMetadata } from '@/generated/api';
import { client } from '@/generated/api/client.gen';
import { useSnackbarStore } from '@/stores/snackbar-store';
import { reconcileExternalPaths } from './file-reconciler';
import { subscribeFileChanges } from './file-change-events';

const fetchMock = vi.fn<typeof fetch>();
const missing = {
  errorCode: 'files.path_not_found',
  message: 'Path not found',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeAll(configureApiClient);
beforeEach(() => {
  fetchMock.mockReset();
  useSnackbarStore.getState().clear();
  client.setConfig({ baseUrl: 'https://mergeron.test', fetch: fetchMock });
});
afterEach(() => {
  clearApiToken();
  vi.restoreAllMocks();
});

it('keeps repeated missing optional-directory probes silent and still reconciles absence', async () => {
  fetchMock.mockImplementation(async () => reply(404, missing));
  const changed = vi.fn();
  const unsubscribe = subscribeFileChanges(changed);
  const paths = ['/work/.agents', '/work/.aws', '/work/.codex'];
  try {
    await reconcileExternalPaths(paths);
    await reconcileExternalPaths(paths);
  } finally {
    unsubscribe();
  }
  expect(fetchMock).toHaveBeenCalledTimes(6);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenLastCalledWith({
    source: 'external',
    kind: 'batch',
    changes: paths.map((path) => ({
      source: 'external',
      kind: 'delete',
      path,
    })),
  });
  expect(useSnackbarStore.getState()).toMatchObject({ visible: [], queue: [] });
});

it('still reports a missing path for an explicit file request and preserves the rejection', async () => {
  fetchMock.mockResolvedValue(reply(404, missing));
  await expect(
    filesGetMetadata({
      query: { path: '/work/report.docx' },
      throwOnError: true,
    }),
  ).rejects.toEqual(missing);
  expect(useSnackbarStore.getState().visible).toMatchObject([
    { severity: 'error', message: 'Path not found' },
  ]);
});

it('does not hide a server failure even if it carries the expected missing-path code', async () => {
  fetchMock.mockResolvedValue(reply(500, missing));
  await expect(
    filesGetMetadata({
      query: { path: '/work/file.ts' },
      throwOnError: true,
      meta: { expectedNotFoundCode: 'files.path_not_found' },
    }),
  ).rejects.toEqual(missing);
  expect(useSnackbarStore.getState().visible).toMatchObject([
    { severity: 'error' },
  ]);
});

it.each([
  [
    403,
    { errorCode: 'files.path_outside_workspace', message: 'Forbidden path' },
  ],
  [500, { errorCode: 'internal_error', message: 'Server unavailable' }],
  [404, { errorCode: 'other.not_found', message: 'Other resource missing' }],
  [404, { message: 'Path not found' }],
])(
  'keeps unexpected probe failures visible (%s, %j) without treating them as deletion',
  async (status, body) => {
    fetchMock.mockResolvedValue(reply(status, body));
    const changed = vi.fn();
    const unsubscribe = subscribeFileChanges(changed);
    try {
      await reconcileExternalPaths(['/work/report.docx']);
    } finally {
      unsubscribe();
    }
    expect(useSnackbarStore.getState().visible).toMatchObject([
      { severity: 'error' },
    ]);
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      source: 'external',
      kind: 'invalidate',
      paths: ['/work/report.docx'],
    });
  },
);

it('preserves authentication-expired recovery for background probes', async () => {
  setApiToken('isolated-test-token');
  fetchMock.mockResolvedValue(reply(401, { errorCode: 'auth.invalid_token' }));
  const expired = vi.fn();
  window.addEventListener('codex-webui:auth-expired', expired);
  try {
    await reconcileExternalPaths(['/work/file.ts']);
  } finally {
    window.removeEventListener('codex-webui:auth-expired', expired);
  }
  expect(expired).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem('codex.webui.jwt')).toBeNull();
});

it('preserves transport recovery instead of silently treating an outage as a missing path', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  const recover = vi.fn(),
    changed = vi.fn();
  const unsubscribe = subscribeFileChanges(changed);
  window.addEventListener('codex-webui:transport-recover', recover);
  try {
    await reconcileExternalPaths(['/work/file.ts']);
  } finally {
    unsubscribe();
    window.removeEventListener('codex-webui:transport-recover', recover);
  }
  expect(recover).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledExactlyOnceWith({
    source: 'external',
    kind: 'invalidate',
    paths: ['/work/file.ts'],
  });
});
