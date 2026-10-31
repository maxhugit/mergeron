import { screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { catalogFixture, json } from './catalog/catalog.testing';
import { InstalledImageChanges } from './installed-image-changes';
import i18n from '@/i18n';

const revision = 'a'.repeat(40);
let fixture: ReturnType<typeof catalogFixture>;
beforeEach(async () => {
  await i18n.changeLanguage('en');
  fixture = catalogFixture();
});
afterEach(() => {
  fixture.dispose();
  vi.unstubAllGlobals();
});
it('keeps installed improvements independent of whether an update is available', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      json({ revision, items: ['Fix registry comparison'], checkError: null }),
    );
  vi.stubGlobal('fetch', fetchMock);
  fixture.render(<InstalledImageChanges revision={revision} enabled />);
  expect(await screen.findByText('Fix registry comparison')).toBeVisible();
  expect(screen.getByRole('link')).toHaveAttribute(
    'href',
    `https://github.com/maxhugit/mergeron/commit/${revision}`,
  );
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('does not request notes for a hidden tab or an unknown revision', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const view = fixture.render(
    <InstalledImageChanges revision={revision} enabled={false} />,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  view.unmount();
  fixture.render(<InstalledImageChanges revision={null} enabled />);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('keeps a safe installed-history link and an honest error when GitHub is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  fixture.render(<InstalledImageChanges revision={revision} enabled />);
  expect(await screen.findByRole('status')).toHaveTextContent(
    'could not be retrieved',
  );
  expect(screen.getByRole('link')).toHaveAttribute(
    'href',
    `https://github.com/maxhugit/mergeron/commit/${revision}`,
  );
});
it('does not show notes from a newer server revision as already installed in the displayed revision', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      json({
        revision: 'b'.repeat(40),
        items: ['Other image'],
        checkError: null,
      }),
    ),
  );
  fixture.render(<InstalledImageChanges revision={revision} enabled />);
  await screen.findByRole('status');
  expect(screen.queryByText('Other image')).not.toBeInTheDocument();
});
