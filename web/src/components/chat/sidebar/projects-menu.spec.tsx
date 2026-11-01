import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ProjectsMenu } from './projects-menu';
it.each([
  'Create a project',
  'Import a project',
  'Collapse projects',
  'Expand projects',
])('offers %s from the plus menu', async (label) => {
  const callbacks = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  render(
    <ProjectsMenu
      onCreate={callbacks[0]}
      onImport={callbacks[1]}
      onCollapse={callbacks[2]}
      onExpand={callbacks[3]}
      canImport
    />,
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Project list actions' }),
  );
  const items = await screen.findAllByRole('menuitem');
  const item = items.find((item) => item.textContent === label)!;
  await userEvent.click(item);
  expect(callbacks[items.indexOf(item)]).toHaveBeenCalledOnce();
});
it('does not expand import permissions', async () => {
  render(
    <ProjectsMenu
      onCreate={vi.fn()}
      onImport={vi.fn()}
      onCollapse={vi.fn()}
      onExpand={vi.fn()}
      canImport={false}
    />,
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Project list actions' }),
  );
  expect(
    screen.getByRole('menuitem', { name: 'Import a project' }),
  ).toHaveAttribute('data-disabled');
});
