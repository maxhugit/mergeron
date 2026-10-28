/** View identities and lifecycle remain independent from documents and shared terminal processes. */
import { beforeEach, expect, it } from 'vitest';
import { fileViewId, useWorkspaceStore } from './workspace-store';
import { useTerminalViewStore } from './terminal-view-store';

beforeEach(() => {
  useWorkspaceStore.setState({ contexts: {}, fileViews: {} });
  useTerminalViewStore.setState({ retained: {}, target: null });
});
it('creates independent browser views beside conversation, capped at five per agent', () => {
  const store = useWorkspaceStore.getState();
  for (let index = 0; index < 6; index++) store.openBrowser('thread:a');
  const current = useWorkspaceStore.getState().contexts['thread:a'];
  expect(current.tabs).toHaveLength(5);
  expect(new Set(current.tabs.map((tab) => tab.id)).size).toBe(5);
  expect(
    current.tabs.map((tab) => (tab.kind === 'browser' ? tab.number : null)),
  ).toEqual([1, 2, 3, 4, 5]);
  store.remove('thread:a', current.tabs[0].id);
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toHaveLength(
    4,
  );
  expect(useWorkspaceStore.getState().contexts['thread:b']).toBeUndefined();
});
it('retains browser layout when other workspace surfaces are opened or closed', () => {
  const store = useWorkspaceStore.getState();
  store.openBrowser('thread:a');
  store.setBrowserLayout('thread:a', {
    browserDocked: true,
    lastBrowserId: 'browser-1',
  });
  store.openFile('thread:a', '/a.ts');
  store.openTerminal('thread:a', 'terminal-a');
  store.select('thread:a', 'conversation');
  expect(useWorkspaceStore.getState().contexts['thread:a']).toMatchObject({
    browserDocked: true,
    lastBrowserId: 'browser-1',
  });
  store.remove('thread:a', 'terminal:terminal-a');
  expect(useWorkspaceStore.getState().contexts['thread:a']).toMatchObject({
    browserDocked: true,
    lastBrowserId: 'browser-1',
  });
});

it('isolates remote files by repository, path and immutable revision, without editable documents', () => {
  const store = useWorkspaceStore.getState();
  const target = {
    projectId: 'p',
    resourceId: 'r',
    path: 'coucou.js',
    ref: 'a'.repeat(40),
  };
  store.openGitRemoteFile('thread:a', target);
  store.openGitRemoteFile('thread:a', target);
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toHaveLength(
    1,
  );
  store.openGitRemoteFile('thread:a', { ...target, ref: 'b'.repeat(40) });
  const current = useWorkspaceStore.getState().contexts['thread:a'];
  expect(current.tabs).toHaveLength(2);
  expect(
    current.tabs.every(
      (tab) => tab.kind === 'git-remote-file' && !('documentId' in tab),
    ),
  ).toBe(true);
  expect(useWorkspaceStore.getState().fileViews).toEqual({});
  expect(useWorkspaceStore.getState().contexts['thread:b']).toBeUndefined();
  for (const tab of current.tabs) store.remove('thread:a', tab.id);
  expect(useWorkspaceStore.getState().contexts['thread:a'].activeId).toBe(
    'conversation',
  );
});

it('opens one graph per repository beside conversation and updates its copy without duplicating tabs', () => {
  const store = useWorkspaceStore.getState();
  const target = {
    projectId: 'p',
    resourceId: 'r',
    name: 'Git Test',
    copyId: null,
  };
  store.openGitGraph('thread:a', target);
  const first = useWorkspaceStore.getState().contexts['thread:a'];
  expect(first.tabs[0]).toMatchObject({ kind: 'git-graph', copyId: null });
  store.select('thread:a', 'conversation');
  store.openGitGraph('thread:a', { ...target, copyId: 'copy' });
  const next = useWorkspaceStore.getState().contexts['thread:a'];
  expect(next.tabs).toHaveLength(1);
  expect(next.tabs[0]).toMatchObject({ copyId: 'copy' });
  expect(next.activeId).toBe(first.activeId);
  expect(useWorkspaceStore.getState().contexts['thread:b']).toBeUndefined();
  store.remove('thread:a', next.activeId);
  expect(useWorkspaceStore.getState().contexts['thread:a'].activeId).toBe(
    'conversation',
  );
});

it('keeps comparisons beside conversation, deduplicated by project/copy/file and separate from editable files', () => {
  const store = useWorkspaceStore.getState();
  const target = {
    projectId: 'p',
    copyId: 'copy',
    path: 'file.ts',
    localPath: '/copy',
    status: ' M',
  };
  store.openGitDiff('thread:a', target);
  const first = useWorkspaceStore.getState().contexts['thread:a'];
  expect(first.tabs[0].kind).toBe('git-diff');
  store.select('thread:a', 'conversation');
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toHaveLength(
    1,
  );
  store.openGitDiff('thread:a', target);
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toHaveLength(
    1,
  );
  store.openGitDiff('thread:a', { ...target, copyId: 'other' });
  store.openFile('thread:a', '/copy/file.ts');
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toHaveLength(
    3,
  );
  expect(useWorkspaceStore.getState().contexts['thread:b']).toBeUndefined();
  store.remove('thread:a', first.activeId);
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toHaveLength(
    2,
  );
  store.forgetConversations(['a']);
  expect(useWorkspaceStore.getState().contexts['thread:a']).toBeUndefined();
});

it('opens one tab per document, with independent navigation requests in each conversation', () => {
  const store = useWorkspaceStore.getState();
  store.openFile('thread:a', '/shared.ts', 3);
  const firstTab = useWorkspaceStore.getState().contexts['thread:a'].tabs[0];
  const first =
    useWorkspaceStore.getState().fileViews[fileViewId('thread:a', firstTab.id)]
      .reveal!;
  store.openFile('thread:a', '/shared.ts', 9);
  store.openFile('thread:b', '/shared.ts', 20);
  const state = useWorkspaceStore.getState();
  expect(state.contexts['thread:a'].tabs).toHaveLength(1);
  expect(
    state.fileViews[fileViewId('thread:a', firstTab.id)].reveal,
  ).toMatchObject({ line: 9 });
  expect(
    state.fileViews[
      fileViewId('thread:b', state.contexts['thread:b'].tabs[0].id)
    ].reveal,
  ).toMatchObject({ line: 20 });
  store.consumeReveal(fileViewId('thread:a', firstTab.id), first.request);
  expect(
    useWorkspaceStore.getState().fileViews[fileViewId('thread:a', firstTab.id)]
      .reveal?.line,
  ).toBe(9);
});

it('cancels navigation when leaving a view, but not when closing an unrelated tab', () => {
  const store = useWorkspaceStore.getState();
  store.openFile('thread:a', '/first.ts');
  store.openFile('thread:a', '/second.ts', 12);
  store.remove(
    'thread:a',
    useWorkspaceStore.getState().contexts['thread:a'].tabs[0].id,
  );
  const secondId = useWorkspaceStore.getState().contexts['thread:a'].tabs[0].id;
  expect(
    useWorkspaceStore.getState().fileViews[
      fileViewId(
        'thread:a',
        useWorkspaceStore.getState().contexts['thread:a'].tabs[0].id,
      )
    ].reveal?.line,
  ).toBe(12);
  store.select('thread:a', 'conversation');
  expect(
    useWorkspaceStore.getState().fileViews[fileViewId('thread:a', secondId)]
      .reveal,
  ).toBeNull();
});

it('keeps tab sets across selection and removes only conversations actually deleted', () => {
  const store = useWorkspaceStore.getState();
  store.openFile('thread:a', '/a.ts');
  store.openFile('thread:b', '/b.ts');
  store.openTerminal('thread:a', 'terminal-a');
  useTerminalViewStore.getState().retain('terminal-a', 'thread:a');
  useTerminalViewStore.getState().retain('terminal-b', 'thread:b');
  store.forgetConversations(['a']);
  expect(useWorkspaceStore.getState().contexts['thread:a']).toBeUndefined();
  expect(
    useWorkspaceStore
      .getState()
      .contexts['thread:b'].tabs.find((tab) => tab.kind === 'file'),
  ).toMatchObject({ path: '/b.ts' });
  expect(useTerminalViewStore.getState().retained).toEqual({
    'terminal-b': 'thread:b',
  });
});

it('falls back to the pinned conversation after its final closable tab is removed', () => {
  const store = useWorkspaceStore.getState();
  store.openFile('thread:a', '/a.ts');
  store.remove(
    'thread:a',
    useWorkspaceStore.getState().contexts['thread:a'].tabs[0].id,
  );
  expect(useWorkspaceStore.getState().contexts['thread:a']).toEqual({
    tabs: [],
    activeId: 'conversation',
  });
});
