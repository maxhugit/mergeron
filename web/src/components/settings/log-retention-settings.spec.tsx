import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import frCommon from '@/locales/fr/common.json';
import frLogs from '@/locales/fr/logs.json';
import { LogRetentionDialog } from '@/components/logs/log-retention-dialog';
import type { LogStorage } from '@/lib/logs-api';
import { catalogFixture, json } from './catalog/catalog.testing';
import { GeneralSettings } from './general-settings';

vi.mock('./server-version-card', () => ({ ServerVersionCard: () => null }));
const saveLogRetentionRule = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logs-api', () => ({
  saveLogRetentionRule,
}));

const policy: LogStorage['policy'] = {
  application: { enabled: true, maxAgeDays: 12, maxFiles: 3 },
  codex: { enabled: false, maxAgeDays: 18, maxFiles: 7, maxFileMiB: 60 },
};
let fixture: ReturnType<typeof catalogFixture>;
beforeEach(() => {
  fixture = catalogFixture();
  saveLogRetentionRule.mockReset().mockResolvedValue({ policy });
});
afterEach(() => fixture.dispose());

it('excludes retention from the server form and its batched saves without changing stored policy', async () => {
  fixture.server.overrides.set('GET /api/settings', () =>
    json({
      settings: [
        {
          key: 'general.updateBackupMode',
          category: 'general',
          type: 'string',
          value: 'minimal',
          defaultValue: 'full',
          source: 'db',
          description: 'Saved update backup scope',
          constraints: { enum: ['full', 'minimal', 'none'] },
        },
        {
          key: 'general.logRetention',
          category: 'general',
          type: 'json',
          value: policy,
          defaultValue: policy,
          source: 'override',
          description: 'Log archive retention',
          constraints: {},
        },
        {
          key: 'general.maxIdleSubscriptions',
          category: 'general',
          type: 'number',
          value: 30,
          defaultValue: 30,
          source: 'default',
          description: 'Maximum idle subscriptions',
          constraints: { min: 1 },
        },
      ],
    }),
  );
  fixture.render(<GeneralSettings />);
  fireEvent.click(screen.getByRole('tab', { name: 'Socket' }));
  const input = await screen.findByRole('spinbutton');
  expect(screen.queryByText('Log Retention')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(fixture.server.writes).toHaveLength(0);
  fireEvent.change(input, { target: { value: '20' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Update' }));
  expect(input).not.toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: 'Socket' }));
  expect(input).toHaveValue(20);
  fireEvent.click(
    screen.getByRole('button', { name: 'Save runtime settings' }),
  );
  await waitFor(() => expect(fixture.server.writes).toHaveLength(1));
  expect(fixture.server.writes[0].body).toEqual({
    updates: [{ key: 'general.maxIdleSubscriptions', value: 20 }],
  });
});

it('uses French labels and saves only the selected current rule from the Logs dialog', async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: 'fr',
    fallbackLng: false,
    defaultNS: 'common',
    ns: ['logs', 'common'],
    resources: { fr: { logs: frLogs, common: frCommon } },
  });
  const close = vi.fn();
  fixture.render(
    <I18nextProvider i18n={i18n}>
      <LogRetentionDialog
        storage={{ policy, files: [], estimatedBytes: 0 }}
        onClose={close}
      />
    </I18nextProvider>,
  );
  fireEvent.pointerDown(
    screen.getByRole('button', { name: 'Actions · Application' }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Paramétrer la rétention' }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Journaux · Application',
  });
  expect(
    within(dialog).getByRole('button', { name: 'Annuler' }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() =>
    expect(saveLogRetentionRule).toHaveBeenCalledWith(
      'application',
      policy.application,
    ),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Journaux · Application' }),
    ).not.toBeInTheDocument(),
  );
  expect(close).not.toHaveBeenCalled();
});
