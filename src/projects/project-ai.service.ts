/** Project automation reports use the managed CLI; no direct OpenAI API client. */
import { Injectable } from '@nestjs/common';
import { ThreadsService } from '../threads/threads.service';

@Injectable()
export class ProjectAiService {
  constructor(private readonly threads: ThreadsService) {}

  async runProjectAutomation(prompt: string, cwd: string): Promise<string> {
    const text = await this.threads.runProjectStructuredPrompt({
      cwd,
      prompt: prompt.slice(0, 30000),
      instructions:
        'Analyse uniquement le contexte fourni et produis un rapport clair en français. Ne modifie aucun fichier et ne prétends pas avoir appliqué de changement.',
      lockedReadOnly: true,
    });
    if (!text.trim())
      throw new Error('The project assistant returned an empty report');
    return text.trim();
  }
}
