/** Durable agent choices. Observations and queued-but-unconfirmed permissions are not choices. */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { settings } from '../database/schema';
import type { ReasoningEffort, v2 } from '../codex/codex-schema';
import type {
  PatchThreadSecurityPolicyDto,
  ThreadSecurityPolicyDto,
} from './dto/thread-security-policy.dto';
import { validateThreadSecurityPolicy } from './thread-security-policy.validation';

export const EXECUTION_PREFERENCE_PREFIX = 'thread-execution-preferences:';
const EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
export interface ExecutionPreferences {
  revision: number;
  model?: string | null;
  effort?: ReasoningEffort | null;
  serviceTier?: string | null;
  security?: PatchThreadSecurityPolicyDto;
}
interface Selection {
  patch: PatchThreadSecurityPolicyDto;
  cwd: string;
  deadline: number;
  accepted: boolean;
  confirmed: boolean;
}
function choices(
  input: unknown,
): Pick<ExecutionPreferences, 'model' | 'effort' | 'serviceTier'> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Invalid execution preferences');
  const data = input as Record<string, unknown>;
  if (
    !Object.keys(data).length ||
    Object.keys(data).some(
      (key) => !['model', 'effort', 'serviceTier'].includes(key),
    )
  )
    throw new BadRequestException('Unsupported execution preference');
  for (const key of ['model', 'serviceTier']) {
    if (
      key in data &&
      data[key] !== null &&
      (typeof data[key] !== 'string' ||
        !data[key].trim() ||
        data[key].length > 200)
    )
      throw new BadRequestException(`Invalid ${key}`);
  }
  if (
    'effort' in data &&
    data.effort !== null &&
    (typeof data.effort !== 'string' || !EFFORTS.has(data.effort))
  )
    throw new BadRequestException('Invalid effort');
  return data;
}
function sandbox(policy: v2.SandboxPolicy | null | undefined, cwd: string) {
  return policy?.type === 'workspaceWrite'
    ? {
        ...policy,
        writableRoots: [
          ...new Set(policy.writableRoots.filter((root) => root !== cwd)),
        ].sort(),
      }
    : policy;
}
function matches(
  selection: Selection,
  observed: Pick<
    ThreadSecurityPolicyDto,
    'observed' | 'approvalPolicy' | 'sandboxPolicy'
  >,
) {
  const patch = selection.patch;
  return (
    observed.observed &&
    (patch.approvalPolicy === undefined ||
      isDeepStrictEqual(patch.approvalPolicy, observed.approvalPolicy)) &&
    (patch.sandboxPolicy === undefined ||
      isDeepStrictEqual(
        sandbox(patch.sandboxPolicy, selection.cwd),
        sandbox(observed.sandboxPolicy, selection.cwd),
      ))
  );
}
@Injectable()
export class ThreadExecutionPreferencesService {
  private readonly logger = new Logger(ThreadExecutionPreferencesService.name);
  private readonly pending = new Map<string, Selection>();
  private readonly failures = new Set<string>();
  constructor(@Inject(DRIZZLE_DB) private readonly db: AppDatabase) {}

  private fail(threadId: string) {
    this.failures.add(threadId);
  }
  private expire(threadId: string) {
    const entry = this.pending.get(threadId);
    if (entry && entry.deadline < Date.now()) {
      this.pending.delete(threadId);
      this.fail(threadId);
    }
  }

  private stored(threadId: string): ExecutionPreferences {
    const raw = this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, EXECUTION_PREFERENCE_PREFIX + threadId))
      .get()?.value;
    if (!raw) return { revision: 0 };
    const value = JSON.parse(raw) as ExecutionPreferences;
    if (!Number.isSafeInteger(value.revision) || value.revision < 0)
      throw new Error('Invalid stored agent settings');
    const { revision, security, ...rest } = value;
    if (Object.keys(rest).length) choices(rest);
    if (security) validateThreadSecurityPolicy(security);
    return { revision, ...rest, ...(security ? { security } : {}) };
  }
  read(threadId: string) {
    this.expire(threadId);
    return {
      ...this.stored(threadId),
      securitySaveState: this.failures.has(threadId)
        ? ('failed' as const)
        : this.pending.has(threadId)
          ? ('pending' as const)
          : null,
    };
  }
  private write(threadId: string, patch: Partial<ExecutionPreferences>) {
    return this.db.transaction(() => {
      const before = this.stored(threadId);
      const value: ExecutionPreferences = {
        ...before,
        ...patch,
        revision: Math.max(Date.now(), before.revision + 1),
      };
      this.db
        .insert(settings)
        .values({
          key: EXECUTION_PREFERENCE_PREFIX + threadId,
          value: JSON.stringify(value),
          type: 'string',
          category: 'thread-execution-preferences',
          description: 'Explicit execution settings saved for this agent',
          defaultValue: '{}',
          constraints: '{}',
          updatedAt: value.revision,
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: JSON.stringify(value), updatedAt: value.revision },
        })
        .run();
      return value;
    });
  }
  set(threadId: string, input: unknown) {
    const patch = choices(input);
    // A different model must not inherit an effort or tier selected for the old one.
    return this.write(threadId, {
      ...('model' in patch ? { effort: null, serviceTier: null } : {}),
      ...patch,
    });
  }
  forTurn(threadId: string): Partial<v2.TurnStartParams> {
    this.expire(threadId);
    if (this.pending.has(threadId))
      throw new ConflictException(
        'Agent permissions are awaiting confirmation',
      );
    if (this.failures.has(threadId))
      throw new ConflictException(
        'Agent permissions could not be saved; review and select them again',
      );
    const value = this.stored(threadId);
    return {
      ...('model' in value ? { model: value.model } : {}),
      ...('effort' in value ? { effort: value.effort } : {}),
      ...('serviceTier' in value ? { serviceTier: value.serviceTier } : {}),
      ...value.security,
    };
  }
  beginSecurity(
    threadId: string,
    patch: PatchThreadSecurityPolicyDto,
    cwd: string,
    observed: ThreadSecurityPolicyDto,
  ) {
    if (JSON.stringify(patch).length > 32768)
      throw new BadRequestException('Agent permissions are too large to save');
    for (const id of this.pending.keys()) this.expire(id);
    if (this.pending.size >= 1000)
      throw new BadRequestException('Too many pending agent settings');
    const entry: Selection = {
      patch,
      cwd,
      deadline: Date.now() + 8000,
      accepted: false,
      confirmed: false,
    };
    entry.confirmed = matches(entry, observed);
    this.pending.set(threadId, entry);
    this.failures.delete(threadId);
    return {
      accept: () => {
        if (this.pending.get(threadId) === entry) {
          entry.accepted = true;
          this.commitSecurity(threadId, entry);
        }
      },
      cancel: () => {
        if (this.pending.get(threadId) === entry) this.pending.delete(threadId);
      },
    };
  }
  observeSecurity(threadId: string, observed: ThreadSecurityPolicyDto) {
    const entry = this.pending.get(threadId);
    if (!entry) return;
    entry.confirmed = matches(entry, observed);
    this.commitSecurity(threadId, entry);
  }
  private commitSecurity(threadId: string, entry: Selection) {
    if (!entry.accepted || !entry.confirmed || entry.deadline < Date.now())
      return;
    try {
      const before = this.stored(threadId);
      this.write(threadId, {
        security: { ...before.security, ...entry.patch },
      });
      this.pending.delete(threadId);
    } catch {
      this.pending.delete(threadId);
      this.fail(threadId);
      this.logger.warn(
        { threadId },
        'Confirmed agent permissions could not be saved',
      );
    }
  }
  clearPending() {
    this.pending.clear();
    this.failures.clear();
  }
  forget(threadId: string) {
    this.pending.delete(threadId);
    this.failures.delete(threadId);
    this.db
      .delete(settings)
      .where(eq(settings.key, EXECUTION_PREFERENCE_PREFIX + threadId))
      .run();
  }
}
