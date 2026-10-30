/** Reconciliation uses component-prefix matches and set-based invalidations. */
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { applyFileChange, reconcileExternalPaths } from './file-reconciler';
import { emitFileChange, subscribeFileChanges } from './file-change-events';
import {
  getAgentFilesStore,
  retainAgentFilesStores,
  useFilesStore,
  useGlobalFilesStore,
} from '@/stores/files-store';
import { useDocumentStore } from '@/stores/document-store';
import {
  filesGetMetadataQueryKey,
  filesReadFileQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
const metadata = vi.hoisted(() => vi.fn());
vi.mock('@/generated/api', async (original) => ({
  ...(await original<typeof import('@/generated/api')>()),
  filesGetMetadata: metadata,
}));

beforeEach(() => {
  retainAgentFilesStores([]);
  vi.clearAllMocks();
  useDocumentStore.setState({ documents: {}, pathIndex: {} });
  useGlobalFilesStore.setState({ rootDir: null, selectedFile: null });
  useFilesStore.setState({
    rootDir: '/work/a/sub',
    selectedFile: '/work/ab/file.ts',
  });
});

it('repairs cached agent explorers without mixing their folders', () => {
  const a = getAgentFilesStore('a');
  const b = getAgentFilesStore('b');
  a.getState().setRootDir('/work/a/sub');
  b.getState().setRootDir('/work/b/sub');
  a.getState().selectFile('/work/a/sub/report.md');
  const client = new QueryClient();
  applyFileChange(client, {
    source: 'local',
    kind: 'rename',
    oldPath: '/work/a',
    newPath: '/work/renamed',
  });
  expect(a.getState().rootDir).toBe('/work/renamed/sub');
  expect(b.getState().rootDir).toBe('/work/b/sub');
  applyFileChange(client, {
    source: 'local',
    kind: 'delete',
    path: '/work/renamed/sub/report.md',
  });
  expect(a.getState().selectedFile).toBeNull();
});

it('repairs the browser directory but leaves a string-prefix sibling alone', () => {
  applyFileChange(new QueryClient(), {
    source: 'local',
    kind: 'rename',
    oldPath: '/work/a',
    newPath: '/work/b',
  });
  expect(useFilesStore.getState()).toMatchObject({
    rootDir: '/work/b/sub',
    selectedFile: '/work/ab/file.ts',
  });
});

it('repairs a retained global browser on rename and deletion without replacing conversation navigation', () => {
  useGlobalFilesStore.setState({
    rootDir: '/global/sub',
    selectedFile: '/global/sub/report.pdf',
  });
  const client = new QueryClient();
  applyFileChange(client, {
    source: 'local',
    kind: 'rename',
    oldPath: '/global',
    newPath: '/renamed',
  });
  expect(useGlobalFilesStore.getState()).toMatchObject({
    rootDir: '/renamed/sub',
    selectedFile: '/renamed/sub/report.pdf',
  });
  expect(useFilesStore.getState().rootDir).toBe('/work/a/sub');
  applyFileChange(client, {
    source: 'local',
    kind: 'delete',
    path: '/renamed/sub/report.pdf',
  });
  expect(useGlobalFilesStore.getState()).toMatchObject({
    rootDir: '/renamed/sub',
    selectedFile: null,
  });
});

it('evicts deleted file queries and refreshes only their parent directory', () => {
  const client = new QueryClient();
  const deletedPath = '/work/report.pdf';
  client.setQueryData(filesReadFileQueryKey({ query: { path: deletedPath } }), {
    content: 'stale',
  });
  client.setQueryData(
    filesGetMetadataQueryKey({ query: { path: deletedPath } }),
    { path: deletedPath },
  );
  const invalidations = vi.spyOn(client, 'invalidateQueries');

  applyFileChange(client, {
    source: 'local',
    kind: 'delete',
    path: deletedPath,
  });

  expect(
    client.getQueryData(
      filesReadFileQueryKey({ query: { path: deletedPath } }),
    ),
  ).toBeUndefined();
  expect(
    client.getQueryData(
      filesGetMetadataQueryKey({ query: { path: deletedPath } }),
    ),
  ).toBeUndefined();
  expect(
    invalidations.mock.calls.map(([filters]) =>
      JSON.stringify(filters?.queryKey),
    ),
  ).toEqual([expect.stringContaining('"root":"/work"')]);
});

it('does not refetch an actively observed resource after it is deleted', async () => {
  const client = new QueryClient();
  const deletedPath = '/work/report.pdf';
  const queryFn = vi.fn().mockResolvedValue({ path: deletedPath });
  const observer = new QueryObserver(client, {
    queryKey: filesGetMetadataQueryKey({ query: { path: deletedPath } }),
    queryFn,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  await observer.refetch();
  queryFn.mockClear();

  applyFileChange(client, {
    source: 'local',
    kind: 'delete',
    path: deletedPath,
  });
  await Promise.resolve();

  unsubscribe();
  expect(queryFn).not.toHaveBeenCalled();
});

it('invalidates a shared parent once for a 50-path batch', () => {
  const client = new QueryClient();
  const invalidations = vi.spyOn(client, 'invalidateQueries');
  applyFileChange(client, {
    source: 'external',
    kind: 'invalidate',
    paths: Array.from({ length: 50 }, (_, i) => `/work/${i}.txt`),
  });
  const keys = invalidations.mock.calls.map(([filters]) =>
    JSON.stringify(filters?.queryKey),
  );
  expect(keys.length).toBe(new Set(keys).size);
  expect(
    keys.filter(
      (key) => key.includes('filesReadTree') && key.includes('"root":"/work"'),
    ),
  ).toHaveLength(1);
});

it('never treats permission or network errors as deletion', async () => {
  metadata.mockRejectedValue({ errorCode: 'auth.invalid_token' });
  const events = vi.fn();
  const unsubscribe = subscribeFileChanges(events);
  await reconcileExternalPaths(['/work/file.ts']);
  unsubscribe();
  expect(events).toHaveBeenCalledExactlyOnceWith({
    source: 'external',
    kind: 'invalidate',
    paths: ['/work/file.ts'],
  });
});

it('ignores internal upload staging paths without requesting metadata', async () => {
  const events = vi.fn();
  const unsubscribe = subscribeFileChanges(events);
  await reconcileExternalPaths([
    '/work/.codex-upload-deadbeef.tmp',
    '/work/nested/.codex-upload-cafebabe.tmp',
  ]);
  unsubscribe();
  expect(metadata).not.toHaveBeenCalled();
  expect(events).not.toHaveBeenCalled();
});

it('ignores delayed watcher echoes for a locally confirmed deletion', async () => {
  const deletedPath = '/work/already-deleted.pdf';
  emitFileChange({ source: 'local', kind: 'delete', path: deletedPath });
  metadata.mockRejectedValue({ errorCode: 'files.path_not_found' });

  await reconcileExternalPaths([deletedPath]);

  expect(metadata).not.toHaveBeenCalled();
});

/**
 * `pnpm probe fs-watch-classification` measured a rename and an unrelated
 * delete-plus-create emitting an identical two-path batch, so this shape must
 * never be promoted to a relocation — the vanished path detaches instead.
 */
it('refuses to read a relocation out of a vanished-plus-appeared pair', async () => {
  metadata.mockImplementation(({ query }: { query: { path: string } }) =>
    query.path === '/work/old.ts'
      ? Promise.reject({ errorCode: 'files.path_not_found' })
      : Promise.resolve({
          data: { type: query.path === '/work' ? 'directory' : 'file' },
        }),
  );
  const events = vi.fn();
  const unsubscribe = subscribeFileChanges(events);
  await reconcileExternalPaths(['/work/new.ts', '/work/old.ts']);
  unsubscribe();
  expect(events).toHaveBeenCalledExactlyOnceWith({
    source: 'external',
    kind: 'batch',
    changes: [
      { source: 'external', kind: 'delete', path: '/work/old.ts' },
      { source: 'external', kind: 'invalidate', paths: ['/work/new.ts'] },
    ],
  });
  expect(events).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'rename' }),
  );
});

it('waits for local rename acknowledgement before inspecting an old pinned file path', async () => {
  const { beginFileMutation, finishFileMutation } =
    await import('./file-change-events');
  const events = vi.fn();
  const unsubscribe = subscribeFileChanges(events);
  metadata.mockRejectedValue({ errorCode: 'files.path_not_found' });
  beginFileMutation();
  const pending = reconcileExternalPaths(['/old.ts']);
  await Promise.resolve();
  expect(metadata).not.toHaveBeenCalled();
  finishFileMutation();
  await pending;
  unsubscribe();
  expect(events).toHaveBeenCalledWith({
    source: 'external',
    kind: 'delete',
    path: '/old.ts',
  });
});

it('invalidates a common directory once for a native batch of 50 deletions', async () => {
  metadata.mockRejectedValue({ errorCode: 'files.path_not_found' });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const unsubscribe = subscribeFileChanges((change) =>
    applyFileChange(client, change),
  );
  await reconcileExternalPaths(
    Array.from({ length: 50 }, (_, i) => `/work/${i}.txt`),
  );
  unsubscribe();
  const keys = invalidate.mock.calls.map(([filters]) =>
    JSON.stringify(filters?.queryKey),
  );
  expect(keys.length).toBe(new Set(keys).size);
  expect(
    keys.filter(
      (key) => key.includes('filesReadTree') && key.includes('"root":"/work"'),
    ),
  ).toHaveLength(1);
});
