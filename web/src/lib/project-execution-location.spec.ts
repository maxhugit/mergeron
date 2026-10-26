import { expect, it } from 'vitest';
import { localExecutionSelection } from './project-execution-location';

const project = {
  workspaces: [
    { id: 'w', name: 'Managed', path: '/workspaces/p', primary: true },
  ],
};

it('sends a stable normalized location id, not an arbitrary execution path', () => {
  expect(localExecutionSelection(project, '/workspaces/p')).toEqual({
    locationId: 'local:w',
    relativePath: '',
  });
});
it('does not silently select another root for an unknown path', () => {
  expect(localExecutionSelection(project, '/workspaces/other')).toBeNull();
  expect(
    localExecutionSelection(project, '/workspaces/p/documents'),
  ).toBeNull();
});
