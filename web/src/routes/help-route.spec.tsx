import { afterEach, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { HelpRoute } from './help-route';
import i18n from '@/i18n';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

it('uses the task-manager tab strip with keyboard navigation and a separate scrolling panel', () => {
  render(<HelpRoute />);
  const tabs = screen.getAllByRole('tab');
  expect(screen.getByRole('tablist')).toHaveClass(
    'h-10',
    'shrink-0',
    'border-b',
  );
  expect(screen.getByRole('tabpanel')).toHaveClass(
    'overflow-y-auto',
    'min-h-0',
  );
  expect(tabs[0]).toHaveAttribute('tabindex', '0');
  tabs[0].focus();
  fireEvent.keyDown(tabs[0], { key: 'End' });
  expect(tabs.at(-1)).toHaveFocus();
  expect(tabs.at(-1)).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('Update / Refresh detection')).toBeInTheDocument();
});

it('documents actions and localized screenshots in both languages', async () => {
  for (const language of ['en', 'fr']) {
    await i18n.changeLanguage(language);
    const { unmount } = render(<HelpRoute />);
    fireEvent.click(screen.getAllByRole('tab')[2]);
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('table')).toBeInTheDocument();
    expect(within(panel).getAllByRole('row')).toHaveLength(4);
    expect(within(panel).getByRole('img')).toHaveAttribute(
      'src',
      `/guide/tasks-${language}.png`,
    );
    expect(within(panel).getByRole('img')).toHaveAttribute('alt');
    expect(panel).not.toHaveTextContent('guide:tasks');
    unmount();
  }
});
