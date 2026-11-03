import { BadRequestException, Injectable } from '@nestjs/common';
import {
  IdentityService,
  type PlatformIdentity,
} from '../auth/identity.service';
import { AgentTeamStore } from './agent-team-store';

@Injectable()
export class AgentTeamsService {
  constructor(
    readonly store: AgentTeamStore,
    private readonly identities: IdentityService,
  ) {}
  authorize(
    identity: PlatformIdentity,
    projectId: string,
    coordinator: string,
  ) {
    if (typeof coordinator !== 'string' || !/^[\w-]{1,128}$/.test(coordinator))
      throw new BadRequestException('TEAM_INVALID_COORDINATOR');
    const actor = this.identities.current(identity);
    this.identities.requireProject(actor, projectId);
    this.identities.requireThread(actor, coordinator);
    return actor;
  }
  list(identity: PlatformIdentity, projectId: string, coordinator: string) {
    const actor = this.authorize(identity, projectId, coordinator);
    return {
      teams: this.store.listSummaries(projectId, coordinator),
      launchAvailable:
        actor.kind === 'person' &&
        actor.role === 'administrator' &&
        !actor.impersonation,
    };
  }
  read(identity: PlatformIdentity, projectId: string, id: string) {
    this.identities.requireProject(
      this.identities.current(identity),
      projectId,
    );
    const team = this.store.read(projectId, id);
    this.authorize(identity, projectId, team.coordinatorThreadId);
    return team;
  }
}
