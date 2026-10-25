import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { settings } from '../database/schema';

export const RESPONSE_DETAILS = ['hidden', 'collapsed', 'expanded'] as const;
export type ResponseDetail = (typeof RESPONSE_DETAILS)[number];
export const RESPONSE_DETAIL_PREFIX = 'thread-response-detail:';

/** Display preference only. Never passed to the model or used during execution. */
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
    return { mode: this.stored(threadId) ?? 'collapsed' };
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
        description: 'Technical activity display selected for this agent',
        defaultValue: 'collapsed',
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
}
