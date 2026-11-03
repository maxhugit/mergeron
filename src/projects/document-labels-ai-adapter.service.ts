import { Injectable, OnModuleInit } from '@nestjs/common';
import { DocumentOrganizationService } from '../deliverables/document-organization.service';
import { ThreadsService } from '../threads/threads.service';
/** Reuses existing Codex CLI structured, ephemeral, read-only execution. */
@Injectable()
export class DocumentLabelsAiAdapter implements OnModuleInit {
  constructor(
    private organization: DocumentOrganizationService,
    private threads: ThreadsService,
  ) {}
  onModuleInit() {
    this.organization.setRunner((input) =>
      this.threads.runProjectStructuredPrompt(input),
    );
  }
}
