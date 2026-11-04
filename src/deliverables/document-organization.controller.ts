import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { DocumentOrganizationService } from './document-organization.service';
@Controller('projects/:projectId/resources/:resourceId/deliverables/:id')
export class DocumentOrganizationController {
  constructor(private service: DocumentOrganizationService) {}
  @Get('organization') read(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
  ) {
    return this.service.read(p, r, id);
  }
  @Post('labels') create(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Body() body: Parameters<DocumentOrganizationService['createLabel']>[3],
  ) {
    return this.service.createLabel(p, r, id, body);
  }
  @Delete('labels/:labelId') remove(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('labelId') label: string,
    @Body() body: Parameters<DocumentOrganizationService['deleteLabel']>[4],
  ) {
    return this.service.deleteLabel(p, r, id, label, body);
  }
  @Put('documents/:documentId/labels') assign(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('documentId') doc: string,
    @Body() body: Parameters<DocumentOrganizationService['assign']>[4],
  ) {
    return this.service.assign(p, r, id, doc, body);
  }
  @Post('organization/proposals') propose(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
  ) {
    return this.service.proposal(p, r, id);
  }
  @Post('organization/proposals/:jobId/apply') apply(
    @Param('projectId') p: string,
    @Param('resourceId') r: string,
    @Param('id') id: string,
    @Param('jobId') job: string,
  ) {
    return this.service.apply(p, r, id, job);
  }
}
