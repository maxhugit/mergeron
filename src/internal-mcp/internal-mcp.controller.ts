import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { currentAccess } from '../auth/access-context';
import { internalMcpCatalog } from './internal-mcp-catalog';

@Controller('internal-mcp')
export class InternalMcpController {
  @Get('catalog')
  catalog() {
    const access = currentAccess();
    if (!access) throw new ForbiddenException('Administrator access required');
    access.identities.requireAdministrator(access.identity);
    return internalMcpCatalog();
  }
}
