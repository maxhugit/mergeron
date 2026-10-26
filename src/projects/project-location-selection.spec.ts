import { expect, it, vi } from 'vitest';
import { ProjectsController } from './projects.controller';
import type { ProjectsService } from './projects.service';

it('passes the explicit location id without changing legacy association callers', async () => {
  const associateAgent = vi.fn();
  const controller = new ProjectsController({
    associateAgent,
  } as unknown as ProjectsService);
  await controller.associateAgent('p', 't', {
    locationId: 'local:w',
    relativePath: 'documents',
  });
  expect(associateAgent).toHaveBeenLastCalledWith(
    'p',
    't',
    { locationId: 'local:w', relativePath: 'documents' },
    false,
  );
  await controller.associateAgent('p', 't', { workspacePath: '/legacy' });
  expect(associateAgent).toHaveBeenLastCalledWith('p', 't', '/legacy', false);
});

it('rejects ambiguous or malformed selections without changing the conversation', () => {
  const associateAgent = vi.fn();
  const controller = new ProjectsController({
    associateAgent,
  } as unknown as ProjectsService);
  for (const body of [
    { locationId: '' },
    { locationId: 'local:w', resourceId: 'other' },
    { locationId: 'local:w', workspacePath: '/other' },
  ])
    expect(() => controller.associateAgent('p', 't', body)).toThrow(
      'one explicit',
    );
  expect(associateAgent).not.toHaveBeenCalled();
});
