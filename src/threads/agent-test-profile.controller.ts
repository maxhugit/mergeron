import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { currentAccess, requireThreadAccess } from '../auth/access-context';
import { CodexService } from '../codex/codex.service';
import { filteredTestNetworkAvailable } from './agent-test-profile';

@ApiTags('threads')
@ApiBearerAuth()
@Controller('threads')
export class AgentTestProfileController {
  constructor(private readonly codex: CodexService) {}

  /** No thread resume, configuration write, permission grant or command execution. */
  @Get(':threadId/test-profile')
  @ApiOperation({
    summary:
      'Check enforced network prerequisites for the optional test profile',
  })
  async read(@Param('threadId') threadId: string) {
    const access = currentAccess();
    if (
      !access ||
      access.identity.role !== 'administrator' ||
      access.identity.impersonation
    )
      return { available: false };
    access.identities.requireActive(access.identity);
    requireThreadAccess(threadId);
    try {
      const requirements = await this.codex.request<unknown>(
        'configRequirements/read',
        {},
      );
      return { available: filteredTestNetworkAvailable(requirements) };
    } catch {
      return { available: false };
    }
  }
}
