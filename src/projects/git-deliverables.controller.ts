import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { GitDeliverablesService } from './git-deliverables.service';

@Controller('projects/:projectId/git-deliverables')
export class GitDeliverablesController {
  constructor(private readonly service: GitDeliverablesService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  status(@Param('projectId') p: string, @Query('copyId') c?: string) {
    return this.service.status(p, c);
  }
  @Post('reconcile')
  reconcile(@Param('projectId') p: string, @Body() body?: unknown) {
    return this.service.reconcile(p, body);
  }
  @Post('configure')
  configure(@Param('projectId') p: string, @Body() body: unknown) {
    return this.service.configure(p, body);
  }
  @Post('preview')
  preview(@Param('projectId') p: string, @Body() body: unknown) {
    return this.service.preview(p, body);
  }
  @Post('apply')
  apply(
    @Param('projectId') p: string,
    @Body()
    body: { options?: unknown; fingerprint?: unknown; resolution?: unknown },
  ) {
    return this.service.apply(p, body);
  }
  @Post('document-preview')
  @Header('Cache-Control', 'private, no-store')
  documentPreview(@Param('projectId') p: string, @Body() body: unknown) {
    return this.service.previewDocument(p, body);
  }
  @Post(':boardId/disable')
  disable(@Param('projectId') p: string, @Param('boardId') r: string) {
    return this.service.disable(p, r);
  }
}
