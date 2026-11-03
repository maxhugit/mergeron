import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { AgentTeamStore } from './agent-team-store';
import { AgentTeamsService } from './agent-teams.service';

const actor: PlatformIdentity = {
  kind: 'person',
  personId: 'person',
  name: 'Person',
  role: 'standard',
  active: true,
};
describe('team read authorization', () => {
  it('checks project access before reading stored content', () => {
    const read = vi.fn();
    const service = new AgentTeamsService(
      { read } as unknown as AgentTeamStore,
      {
        current: () => actor,
        requireProject: () => {
          throw new ForbiddenException();
        },
      } as unknown as IdentityService,
    );
    expect(() => service.read(actor, 'private', 'team')).toThrow(
      ForbiddenException,
    );
    expect(read).not.toHaveBeenCalled();
  });
  it('checks coordinator access before returning mission details', () => {
    const service = new AgentTeamsService(
      {
        read: () => ({ coordinatorThreadId: 'private' }),
      } as unknown as AgentTeamStore,
      {
        current: () => actor,
        requireProject() {},
        requireThread: () => {
          throw new ForbiddenException();
        },
      } as unknown as IdentityService,
    );
    expect(() => service.read(actor, 'p', 'team')).toThrow(ForbiddenException);
  });
  it('rejects missing coordinator filters rather than listing other conversations', () => {
    const list = vi.fn();
    const service = new AgentTeamsService(
      { list } as unknown as AgentTeamStore,
      {} as IdentityService,
    );
    expect(() => service.list(actor, 'p', '')).toThrow(
      'TEAM_INVALID_COORDINATOR',
    );
    expect(list).not.toHaveBeenCalled();
  });
});
