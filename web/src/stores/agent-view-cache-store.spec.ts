import { beforeEach, expect, it } from 'vitest';
import {
  MAX_CACHED_AGENT_VIEWS,
  useAgentViewCacheStore as cache,
} from './agent-view-cache-store';
import { useComposerDraftStore as drafts } from './composer-draft-store';
import { getAgentFilesStore, retainAgentFilesStores } from './files-store';
beforeEach(() => {
  cache.getState().clear();
  drafts.setState({ drafts: {}, forgotten: new Set() });
  retainAgentFilesStores([]);
});
it('opts into exactly one project, replacing the old one and toggling off', () => {
  cache.getState().toggleProject('p');
  cache.getState().visit('p', 'a');
  cache.getState().visit('other', 'outside');
  expect(cache.getState().threadIds).toEqual(['a']);
  cache.getState().toggleProject('other');
  expect(cache.getState()).toMatchObject({ projectId: 'other', threadIds: [] });
  cache.getState().toggleProject('other');
  expect(cache.getState()).toMatchObject({ projectId: null, threadIds: [] });
});
it('keeps a five-view LRU, not every agent in the project', () => {
  cache.getState().toggleProject('p');
  for (let n = 0; n < 10; n++) cache.getState().visit('p', String(n));
  expect(cache.getState().threadIds).toHaveLength(MAX_CACHED_AGENT_VIEWS);
  expect(cache.getState().threadIds).toEqual(['5', '6', '7', '8', '9']);
  cache.getState().visit('p', '5');
  expect(cache.getState().threadIds).toEqual(['6', '7', '8', '9', '5']);
  cache.getState().forget(['7', '9']);
  expect(cache.getState().threadIds).toEqual(['6', '8', '5']);
});
it('keeps small per-agent drafts and attachments even when their view is evicted', () => {
  drafts.getState().setText('a', 'unfinished');
  drafts
    .getState()
    .setAttachments('a', [
      { type: 'mention', id: 'f', displayName: 'report', path: '/a/report' },
    ]);
  drafts.getState().setText('b', 'different');
  cache.getState().clear();
  expect(drafts.getState().drafts.a).toMatchObject({
    text: 'unfinished',
    attachments: [{ path: '/a/report' }],
  });
  drafts.getState().setText('a', (text) => text + ' message');
  expect(drafts.getState().drafts.a.text).toBe('unfinished message');
  expect(drafts.getState().drafts.b.text).toBe('different');
  drafts.getState().forget(['a']);
  drafts.getState().setText('a', 'late upload callback');
  expect(drafts.getState().drafts.a).toBeUndefined();
});
it('isolates explorer navigation, and frees evicted explorer state', () => {
  const a = getAgentFilesStore('a');
  const b = getAgentFilesStore('b');
  a.getState().setRootDir('/a/sub');
  b.getState().setRootDir('/b/sub');
  expect(getAgentFilesStore('a')).toBe(a);
  expect(a.getState().rootDir).toBe('/a/sub');
  retainAgentFilesStores(['b']);
  expect(getAgentFilesStore('a')).not.toBe(a);
  expect(getAgentFilesStore('b')).toBe(b);
});
