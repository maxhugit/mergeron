import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { settings } from '../database/schema';

export const RESPONSE_DETAILS = ['concise', 'normal', 'detailed'] as const;
export type ResponseDetail = (typeof RESPONSE_DETAILS)[number];
export const RESPONSE_DETAIL_PREFIX = 'thread-response-detail:';

const guidance: Record<ResponseDetail, string> = {
  concise:
    'Use concise responses: lead with the result, keep progress updates short and omit unnecessary technical detail. Still explain failures, risks and decisions requiring the user. Do not omit essential facts or reduce task thoroughness.',
  normal:
    'Use balanced responses: explain the result and useful context, without unnecessary repetition or exhaustive technical detail. Include important failures, risks and decisions requiring the user.',
  detailed:
    'Use detailed responses: explain the result, relevant steps, evidence, verification and limitations. Include useful technical details when relevant, without dumping irrelevant raw output or exposing secrets.',
};

/** Presentation preference only: never changes permissions, reasoning effort or execution. */
@Injectable()
export class ThreadResponseDetailService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: AppDatabase) {}

  private stored(threadId: string): ResponseDetail | null {
    const value = this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, RESPONSE_DETAIL_PREFIX + threadId))
      .get()?.value;
    return RESPONSE_DETAILS.includes(value as ResponseDetail)
      ? (value as ResponseDetail)
      : null;
  }

  read(threadId: string): { mode: ResponseDetail } {
    return { mode: this.stored(threadId) ?? 'normal' };
  }

  set(threadId: string, mode: ResponseDetail) {
    const updatedAt = Date.now();
    this.db
      .insert(settings)
      .values({
        key: RESPONSE_DETAIL_PREFIX + threadId,
        value: mode,
        type: 'string',
        category: 'thread-response-detail',
        description: 'Response detail selected for this agent',
        defaultValue: 'normal',
        constraints: '{}',
        updatedAt,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: mode, updatedAt },
      })
      .run();
    return { mode };
  }

  context(threadId: string): string {
    const mode = this.stored(threadId) ?? 'normal';
    return `<agent_response_detail>\nResponse presentation preference for this agent: ${mode}. This replaces earlier presentation preferences.\n${guidance[mode]}\nFollow the user's language and any specific request for detail in the current task. This preference does not change tools, safety rules or access rights.\n</agent_response_detail>`;
  }
}
