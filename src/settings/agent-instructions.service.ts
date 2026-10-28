import { Injectable } from '@nestjs/common';
import { SettingsService } from './settings.service';
import {
  AGENT_INSTRUCTIONS_KEY,
  agentInstructionsContext,
} from './agent-instructions';

/** Resolve on every turn: existing agents see admin edits without a restart. */
@Injectable()
export class AgentInstructionsService {
  constructor(private readonly settings: SettingsService) {}

  context(): string {
    const text = this.settings.getSetting(AGENT_INSTRUCTIONS_KEY).value;
    return agentInstructionsContext(typeof text === 'string' ? text : '');
  }
}
