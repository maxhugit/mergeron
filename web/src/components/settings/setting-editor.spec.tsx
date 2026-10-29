import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { SettingEditor } from './setting-editor';
import { parseDraftValue, type RuntimeSetting } from './setting-helpers';

const setting: RuntimeSetting = {
  key: 'security.projectAgentTestProfile',
  type: 'boolean',
  category: 'security',
  updatedAt: 0,
  value: true,
  defaultValue: true,
  source: 'default',
  description: 'projectAgentTestProfileDescription',
  constraints: {},
};
beforeEach(async () => {
  await i18n.changeLanguage('fr');
});
it('edits the global new-agent boolean as a switch, using the existing save conversion', async () => {
  const user = userEvent.setup();
  const onDraftChange = vi.fn();
  const props = {
    setting,
    draft: 'true',
    disabled: false,
    onDraftChange,
    onReset: vi.fn(),
  };
  const view = render(<SettingEditor {...props} />);
  const toggle = screen.getByRole('switch');
  expect(toggle).toHaveAccessibleName(
    'Profil de test des nouveaux agents de projet',
  );
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(onDraftChange).toHaveBeenCalledExactlyOnceWith(setting.key, 'false');
  expect(parseDraftValue(setting, 'false')).toEqual({ ok: true, value: false });
  view.rerender(<SettingEditor {...props} draft="false" disabled />);
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeDisabled();
  await user.click(toggle);
  expect(onDraftChange).toHaveBeenCalledTimes(1);
});
