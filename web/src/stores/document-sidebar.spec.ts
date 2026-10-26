import { beforeEach, expect, it } from 'vitest';
import {
  desktopSidebarCollapsedForPath,
  isDocumentWindow,
  useLayoutStore,
} from './layout-store';

beforeEach(() => {
  localStorage.clear();
  useLayoutStore.setState({
    desktopSidebarCollapsed: false,
    documentSidebarCollapsed: true,
  });
});

it('starts document windows collapsed even when the main sidebar is expanded', () => {
  const state = useLayoutStore.getState();
  expect(desktopSidebarCollapsedForPath(state, '/document')).toBe(true);
  expect(desktopSidebarCollapsedForPath(state, '/document/')).toBe(true);
  expect(desktopSidebarCollapsedForPath(state, '/projects/p/resources/r')).toBe(
    false,
  );
});

it('lets a document window reopen its sidebar without modifying the main preference', () => {
  useLayoutStore.getState().setDesktopSidebarCollapsed(true);
  useLayoutStore.getState().toggleDocumentSidebarCollapsed();
  const state = useLayoutStore.getState();
  expect(desktopSidebarCollapsedForPath(state, '/document')).toBe(false);
  expect(desktopSidebarCollapsedForPath(state, '/settings')).toBe(true);
  const stored = JSON.parse(localStorage.getItem('codex.webui.layout')!).state;
  expect(stored.desktopSidebarCollapsed).toBe(true);
  expect(stored).not.toHaveProperty('documentSidebarCollapsed');
});

it('does not change document layout when the ordinary sidebar is toggled', () => {
  useLayoutStore.getState().toggleDesktopSidebarCollapsed();
  expect(useLayoutStore.getState().documentSidebarCollapsed).toBe(true);
  expect(isDocumentWindow('/documents')).toBe(false);
  expect(isDocumentWindow('/projects/document')).toBe(false);
});
