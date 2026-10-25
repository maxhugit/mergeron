import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskDetailSurface } from './task-detail-surface';

describe('TaskDetailSurface', () => {
  it('opens the task inline with a return action, not a dialog', () => {
    const close = vi.fn();
    render(
      <TaskDetailSurface
        open
        embedded={false}
        onClose={close}
        title="Modifier la tâche"
      >
        <input aria-label="Titre" />
      </TaskDetailSurface>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByRole('region', { name: 'Modifier la tâche' }),
    ).toContainElement(screen.getByRole('textbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Retour' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not mount the editor when closed', () => {
    render(
      <TaskDetailSurface
        open={false}
        embedded={false}
        onClose={vi.fn()}
        title="Tâche"
      >
        <input aria-label="Titre" />
      </TaskDetailSurface>,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
