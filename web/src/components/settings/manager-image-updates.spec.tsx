import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { catalogFixture, json } from './catalog/catalog.testing';
import { ManagerImageUpdates } from './manager-image-updates';

afterEach(() => vi.unstubAllGlobals());
it('requests a confirmed update of exactly the selected component, using its digest', async () => {
  const digest = `sha256:${'b'.repeat(64)}`;
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        json({
          checkedAt: '',
          components: [
            {
              id: 'ingress',
              displayName: 'Mergeron Ingress',
              targetImage: 'nginx:stable',
              targetDigest: digest,
              updateAvailable: true,
              checkError: null,
            },
            {
              id: 'egress',
              displayName: 'Mergeron Squid',
              targetImage: 'ubuntu/squid:latest',
              targetDigest: digest,
              updateAvailable: false,
              checkError: null,
            },
          ],
        }),
      ),
    ),
  );
  const fixture = catalogFixture();
  await i18n.changeLanguage('fr');
  const update = vi.fn();
  const view = fixture.render(
    <ManagerImageUpdates disabled={false} onUpdate={update} />,
  );
  await userEvent.click(
    await screen.findByRole('button', {
      name: 'Mettre à jour Mergeron Ingress…',
    }),
  );
  expect(update).toHaveBeenCalledExactlyOnceWith({
    ingress: `nginx@${digest}`,
  });
  expect(
    screen.getByRole('button', { name: 'Mettre à jour Mergeron Squid…' }),
  ).toBeDisabled();
  view.unmount();
  fixture.dispose();
});

it('does not offer an installation when the platform comparison is unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      json({
        checkedAt: '',
        components: [
          {
            id: 'ingress',
            displayName: 'Nginx',
            targetImage: 'nginx:stable',
            targetDigest: `sha256:${'b'.repeat(64)}`,
            updateAvailable: false,
            checkError: 'platformIdentityUnavailable',
            versionStatus: 'unknown',
          },
        ],
      }),
    ),
  );
  const fixture = catalogFixture();
  await i18n.changeLanguage('fr');
  const update = vi.fn();
  const view = fixture.render(
    <ManagerImageUpdates disabled={false} onUpdate={update} />,
  );
  expect(
    await screen.findByText(/Impossible de vérifier l’image propre/),
  ).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Mettre à jour Nginx…' }),
  ).toBeDisabled();
  expect(update).not.toHaveBeenCalled();
  view.unmount();
  fixture.dispose();
});
