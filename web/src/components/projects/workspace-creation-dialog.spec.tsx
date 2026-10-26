import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkspaceCreationDialog } from './workspace-creation-dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: globalThis.__testTranslate }),
}));
vi.mock('@/components/files/directory-selection-tree', () => ({
  DirectorySelectionTree: ({
    onSelectedPathChange,
  }: {
    onSelectedPathChange: (path: string) => void;
  }) => (
    <button onClick={() => onSelectedPathChange('/workspaces/demo')}>
      Select demo folder
    </button>
  ),
}));

const renderDialog = () => {
  const onCreateLocal = vi.fn();
  const onCreateExternal = vi.fn();
  render(
    <WorkspaceCreationDialog
      open
      pending={false}
      onClose={vi.fn()}
      onCreateLocal={onCreateLocal}
      onCreateExternal={onCreateExternal}
    />,
  );
  return { onCreateLocal, onCreateExternal };
};

it('offers local, Git, SSH and FTP workspace sources from one action', () => {
  renderDialog();
  expect(screen.getByRole('button', { name: /Local folder/ })).toBeVisible();
  expect(
    screen.getByRole('button', { name: /GitHub or Git repository/ }),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: /^SSH/ })).toBeVisible();
  expect(screen.getByRole('button', { name: /^SFTP/ })).toBeVisible();
  expect(screen.getByRole('button', { name: /^FTPS/ })).toBeVisible();
  expect(screen.getByRole('button', { name: /^FTP(?!S)/ })).toBeVisible();
});

it('keeps the existing directory picker for a local workspace', () => {
  const { onCreateLocal } = renderDialog();
  fireEvent.click(screen.getByRole('button', { name: /Local folder/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Select demo folder' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Add a location or connection' }),
  );
  expect(onCreateLocal).toHaveBeenCalledWith('/workspaces/demo');
});

it('builds an external Git resource from the same workspace dialog', () => {
  const { onCreateExternal } = renderDialog();
  fireEvent.click(
    screen.getByRole('button', { name: /GitHub or Git repository/ }),
  );
  fireEvent.change(screen.getByLabelText('Connection name'), {
    target: { value: 'Product repository' },
  });
  fireEvent.change(screen.getByLabelText('Repository URL'), {
    target: { value: 'https://github.com/example/product.git' },
  });
  fireEvent.change(screen.getByLabelText('Access token'), {
    target: { value: 'secret-token' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Add a location or connection' }),
  );

  expect(onCreateExternal).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'Product repository',
      type: 'git',
      address: 'https://github.com/example/product.git',
      accessMode: 'read_only',
      secret: expect.objectContaining({ password: 'secret-token' }),
    }),
  );
});
