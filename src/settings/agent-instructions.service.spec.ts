import { ConfigService } from '@nestjs/config';
import { createTestDatabase } from '../database/database.testing';
import { SettingsService } from './settings.service';
import { AgentInstructionsService } from './agent-instructions.service';
import {
  AGENT_INSTRUCTIONS_KEY,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  DEFAULT_AGENT_INSTRUCTIONS,
} from './agent-instructions';

describe('Common agent instructions', () => {
  it('seeds a desktop/mobile policy requiring actual image inspection, not a smoke-only claim', () => {
    const { db, sqlite } = createTestDatabase();
    try {
      const service = new SettingsService(db, new ConfigService());
      const context = new AgentInstructionsService(service).context();
      expect(context).toContain('mergeron-environment-check --cwd');
      expect(context).toContain('ajoutez --visual');
      expect(context).toContain('ne télécharge rien');
      expect(context).toContain('mergeron-visual-check --help');
      expect(context).toContain('desktop.png, mobile.png');
      expect(context).toContain('Ouvrez réellement les captures');
      expect(context).toContain('Ne prétendez jamais');
      expect(context).toContain('Respectez les permissions, le sandbox, TLS');
      expect(service.getSetting(AGENT_INSTRUCTIONS_KEY)).toMatchObject({
        value: DEFAULT_AGENT_INSTRUCTIONS,
        source: 'default',
      });
    } finally {
      sqlite.close();
    }
  });

  it('refreshes an existing service immediately and persists administrator overrides across a restart', () => {
    const { db, sqlite } = createTestDatabase();
    try {
      const settings = new SettingsService(db, new ConfigService());
      const service = new AgentInstructionsService(settings);
      settings.updateSetting(
        AGENT_INSTRUCTIONS_KEY,
        'Inspect desktop and mobile.',
      );
      expect(service.context()).toContain('Inspect desktop and mobile.');
      const restarted = new SettingsService(db, new ConfigService());
      expect(new AgentInstructionsService(restarted).context()).toBe(
        service.context(),
      );
      settings.updateSetting(AGENT_INSTRUCTIONS_KEY, 'Updated instructions');
      expect(service.context()).toContain('Updated instructions');
      expect(service.context()).not.toContain('Inspect desktop and mobile.');
      settings.resetSetting(AGENT_INSTRUCTIONS_KEY);
      expect(service.context()).toContain(
        JSON.stringify(DEFAULT_AGENT_INSTRUCTIONS),
      );
    } finally {
      sqlite.close();
    }
  });

  it('supports explicit disabling and rejects oversized or non-text values without changing the saved value', () => {
    const { db, sqlite } = createTestDatabase();
    try {
      const settings = new SettingsService(db, new ConfigService());
      settings.updateSetting(AGENT_INSTRUCTIONS_KEY, '');
      expect(settings.getSetting(AGENT_INSTRUCTIONS_KEY)).toMatchObject({
        source: 'db',
        value: '',
      });
      expect(new AgentInstructionsService(settings).context()).toContain(
        'un texte vide les désactive',
      );
      for (const bad of [
        42,
        {},
        ['text'],
        'a'.repeat(AGENT_INSTRUCTIONS_MAX_LENGTH + 1),
      ]) {
        expect(() =>
          settings.updateSetting(AGENT_INSTRUCTIONS_KEY, bad),
        ).toThrow();
        expect(settings.getSetting(AGENT_INSTRUCTIONS_KEY).value).toBe('');
      }
      expect(() =>
        settings.updateSetting(
          AGENT_INSTRUCTIONS_KEY,
          'a'.repeat(AGENT_INSTRUCTIONS_MAX_LENGTH),
        ),
      ).not.toThrow();
    } finally {
      sqlite.close();
    }
  });
});
