import { AgentTeamVisibilityService } from './agent-team-visibility.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
    private readonly visibility: AgentTeamVisibilityService,
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
      teams: this.store
        .listSummaries(projectId, coordinator)
        .filter((team) => this.visibility.canRead(actor, projectId, team)),
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
    const actor = this.authorize(identity, projectId, team.coordinatorThreadId);
    try {
      this.visibility.assert(actor, projectId, team);
    } catch {
      throw new NotFoundException('TEAM_NOT_FOUND');
    }
    return team;
  }
}
