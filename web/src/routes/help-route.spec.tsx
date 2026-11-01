import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { HelpRoute } from './help-route';
import i18n from '@/i18n';
beforeEach(async () => {
  window.history.replaceState(null, '', '/help');
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

it('separates simple conversations from work agents in an expandable contents list', () => {
  render(<HelpRoute />);
  expect(
    screen.getByRole('button', { name: /Simple conversations/ }),
  ).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: /Work agents/ }));
  fireEvent.click(
    within(document.getElementById('guide-navigation')!).getByRole('link', {
      name: 'Create and assign an agent',
    }),
  );
  expect(screen.getByRole('article')).toHaveAccessibleName(
    'Create and assign an agent',
  );
  expect(screen.getByRole('article')).toHaveFocus();
  expect(window.location.hash).toBe('#guide/agent-create');
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
});
it('searches full article text without accents and opens the result', async () => {
  await i18n.changeLanguage('fr');
  render(<HelpRoute />);
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'retention' },
  });
  const navigation = within(document.getElementById('guide-navigation')!);
  fireEvent.click(
    navigation.getByRole('link', {
      name: /Sauvegardes, rétention et restauration/,
    }),
  );
  expect(screen.getByRole('article')).toHaveAccessibleName(
    'Sauvegardes, rétention et restauration',
  );
  expect(screen.getByRole('article')).toHaveTextContent(
    'après une mise à jour réussie',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Effacer la recherche' }));
  expect(screen.getByRole('searchbox')).toHaveValue('');
});
it('reports no results without hiding the selected article', () => {
  render(<HelpRoute />);
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: '<script>not-found</script>' },
  });
  expect(screen.getByText(/No matching articles/)).toBeInTheDocument();
  expect(screen.getByRole('article')).toHaveAccessibleName(
    'Understand the platform',
  );
});
it('opens the project and each feedback form through explicit safe GitHub links', () => {
  render(<HelpRoute />);
  const project = screen.getByRole('link', {
    name: /Mergeron project on GitHub/,
  });
  expect(project).toHaveAttribute(
    'href',
    'https://github.com/maxhugit/mergeron',
  );
  expect(project).toHaveAttribute('target', '_blank');
  expect(project).toHaveAttribute('rel', 'noopener noreferrer');
  for (const [id, label, template] of [
    ['report-bug', 'Open the bug report form on GitHub', 'bug_report.yml'],
    [
      'request-improvement',
      'Open the improvement form on GitHub',
      'feature_request.yml',
    ],
  ]) {
    window.history.replaceState(null, '', `/help#guide/${id}`);
    fireEvent.popState(window);
    const link = within(screen.getByRole('article')).getByRole('link', {
      name: new RegExp(label),
    });
    expect(link).toHaveAttribute(
      'href',
      `https://github.com/maxhugit/mergeron/issues/new?template=${template}`,
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('form')).toBeNull();
  }
});
it('supports direct links and browser history events', () => {
  window.history.replaceState(null, '', '/help#guide/git-pr');
  render(<HelpRoute />);
  expect(screen.getByRole('article')).toHaveAccessibleName(
    'Create and follow a pull request',
  );
  window.history.replaceState(null, '', '/help#guide/simple-chat');
  fireEvent.popState(window);
  expect(screen.getByRole('article')).toHaveAccessibleName(
    'Create a simple conversation',
  );
});
it('keeps article links and history on the help route with the application base URL', () => {
  const base = document.createElement('base');
  base.href = '/';
  document.head.append(base);
  try {
    window.history.replaceState({ guide: true }, '', '/help?source=guide');
    render(<HelpRoute />);
    const link = within(document.getElementById('guide-navigation')!).getByRole(
      'link',
      {
        name: 'Create your first project',
      },
    );
    expect(link).toHaveAttribute(
      'href',
      '/help?source=guide#guide/first-project',
    );
    fireEvent.click(link);
    expect(window.location.pathname).toBe('/help');
    expect(window.location.search).toBe('?source=guide');
    expect(window.location.hash).toBe('#guide/first-project');
    expect(window.history.state).toEqual({ guide: true });
  } finally {
    base.remove();
  }
});
it('falls back safely for unknown or malformed links', () => {
  window.history.replaceState(null, '', '/help#guide/%E0%A4%A');
  render(<HelpRoute />);
  expect(screen.getByRole('article')).toHaveAccessibleName(
    'Understand the platform',
  );
});
it('keeps the same article when the interface language changes', async () => {
  window.history.replaceState(null, '', '/help#guide/infrastructure');
  render(<HelpRoute />);
  await act(async () => {
    await i18n.changeLanguage('fr');
  });
  expect(screen.getByRole('article')).toHaveAccessibleName(
    'Infrastructure et Mergeron Manager',
  );
  expect(screen.getByRole('article')).toHaveTextContent(
    'mettre à jour séparément son image publiée',
  );
});
it.each(['fr', 'en'])(
  'retains real localized captures and action explanations in %s',
  async (language) => {
    await i18n.changeLanguage(language);
    window.history.replaceState(null, '', '/help#guide/task-board');
    render(<HelpRoute />);
    const article = screen.getByRole('article');
    expect(within(article).getByRole('img')).toHaveAttribute(
      'src',
      `/guide/tasks-${language}.png`,
    );
    expect(within(article).getAllByRole('list').length).toBeGreaterThan(0);
  },
);
