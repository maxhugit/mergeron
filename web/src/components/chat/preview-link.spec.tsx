import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PreviewLink } from './preview-link';
import {
  PreviewLinkContext,
  couldBePreviewLink,
} from '@/lib/preview-link-context';
import { projectsApi } from '@/lib/projects-api';
vi.mock('@/lib/projects-api', () => ({ projectsApi: vi.fn() }));
const href =
  'https://22222222-2222-4222-8222-222222222222.preview.example.org/';
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(projectsApi).mockReset();
});
function fixture() {
  const tab = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  render(
    <PreviewLinkContext.Provider
      value={{ projectId: 'project', threadId: 'agent' }}
    >
      <PreviewLink href={href}>Preview</PreviewLink>
    </PreviewLinkContext.Provider>,
  );
  return tab;
}
it('authorizes the actual server-bound preview only after a human link click, without agent credentials', async () => {
  const tab = fixture();
  const grant =
    href + '.__mergeron_preview/open#mergeron-preview=browser-only-ticket';
  vi.mocked(projectsApi)
    .mockResolvedValueOnce({ preview: { ready: true, url: href } })
    .mockResolvedValueOnce({ url: grant });
  expect(projectsApi).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: 'Preview' }));
  await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(grant));
  expect(projectsApi).toHaveBeenNthCalledWith(
    1,
    '/project/agents/agent/preview',
  );
  expect(projectsApi).toHaveBeenNthCalledWith(
    2,
    '/project/agents/agent/preview/open',
    { method: 'POST' },
  );
  expect(tab.opener).toBeNull();
});
it('never mints a ticket for an unrelated or forged UUID-host URL', async () => {
  const tab = fixture();
  vi.mocked(projectsApi).mockResolvedValueOnce({
    preview: { ready: true, url: 'https://different.example.org/' },
  });
  fireEvent.click(screen.getByRole('link'));
  await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(href));
  expect(projectsApi).toHaveBeenCalledTimes(1);
});
it('does not disclose a returned grant to a different origin', async () => {
  const tab = fixture();
  vi.mocked(projectsApi)
    .mockResolvedValueOnce({ preview: { ready: true, url: href } })
    .mockResolvedValueOnce({
      url: 'https://other.example.org/.__mergeron_preview/open#secret',
    });
  fireEvent.click(screen.getByRole('link'));
  await waitFor(() => expect(tab.close).toHaveBeenCalled());
  expect(tab.location.replace).not.toHaveBeenCalled();
});
it('leaves normal links alone and never treats credentials or unsafe URLs as preview hints', () => {
  for (const value of [
    'https://github.com/maxhugit/mergeron',
    href + '?ticket=secret',
    href + '#token',
    href.replace('https://', 'http://'),
    href.replace('https://', 'https://user:pass@'),
    'javascript:alert(1)',
  ])
    expect(couldBePreviewLink(value)).toBe(false);
  expect(couldBePreviewLink(href)).toBe(true);
});
