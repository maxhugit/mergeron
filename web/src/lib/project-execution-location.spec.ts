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
  expect(localExecutionSelection(project, '/workspaces/p-other')).toBeNull();
});

it.each(['documents', '.mergeron-system/livrables/d'])(
  'retains a nested reference: %s',
  (relativePath) => {
    expect(
      localExecutionSelection(project, `/workspaces/p/${relativePath}`),
    ).toEqual({
      locationId: 'local:w',
      relativePath,
    });
  },
);

it('uses the most specific attached workspace', () => {
  expect(
    localExecutionSelection(
      {
        workspaces: [
          ...project.workspaces,
          { id: 'copy', path: '/workspaces/p/sources/copy' },
        ],
      },
      '/workspaces/p/sources/copy/docs',
    ),
  ).toEqual({
    locationId: 'local:copy',
    relativePath: 'docs',
  });
});

it.each(['../other', 'documents/../../other', './documents'])(
  'rejects traversal: %s',
  (relativePath) => {
    expect(
      localExecutionSelection(project, `/workspaces/p/${relativePath}`),
    ).toBeNull();
  },
);
