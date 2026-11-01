import { beforeEach, expect, it } from 'vitest';
import { useLayoutStore as layout } from './layout-store';
beforeEach(() =>
  layout.setState({
    collapsedGroupKeys: [],
    focusedProjectId: null,
    sidebarView: { type: 'overview' },
  }),
);
it('collapses/expands the listed projects only, without losing other collapse preferences', () => {
  layout.setState({ collapsedGroupKeys: ['/old'] });
  layout.getState().setGroupsCollapsed(['/a', '/b'], true);
  layout.getState().setGroupsCollapsed(['/a', '/b'], true);
  expect(layout.getState().collapsedGroupKeys).toEqual(['/old', '/a', '/b']);
  layout.getState().setGroupsCollapsed(['/a', '/b'], false);
  expect(layout.getState().collapsedGroupKeys).toEqual(['/old']);
});
it('focus and return preserve the original group fold state and do not persist focus', () => {
  layout.setState({ collapsedGroupKeys: ['/a'] });
  layout.getState().setFocusedProject('a');
  expect(layout.getState().focusedProjectId).toBe('a');
  layout.getState().setFocusedProject(null);
  expect(layout.getState().collapsedGroupKeys).toEqual(['/a']);
  expect(
    JSON.parse(localStorage.getItem('codex.webui.layout')!).state,
  ).not.toHaveProperty('focusedProjectId');
});
