import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { usePwaInstall } from '@/lib/pwa-install';
import { PwaInstall } from './pwa-install';
beforeEach(() =>
  usePwaInstall.setState({ promptEvent: null, installed: false }),
);
it('offers manual Edge instructions without claiming a browser prompt is available', async () => {
  render(<PwaInstall />);
  fireEvent.click(screen.getByRole('button', { name: 'Install the app' }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('In Edge:');
  expect(screen.getByRole('dialog')).toHaveTextContent('private browsing');
});
it('does not offer installation in an already installed app', () => {
  usePwaInstall.setState({ installed: true });
  render(<PwaInstall />);
  expect(screen.getByRole('button', { name: 'App installed' })).toBeDisabled();
});
