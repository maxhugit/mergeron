import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

export interface LogRetentionRule {
  enabled: boolean;
  maxAgeDays: number;
  maxFiles: number;
}
export interface LogRetentionPolicy {
  application: LogRetentionRule;
  codex: LogRetentionRule & { maxFileMiB: number };
}
export interface LogStorage {
  estimatedBytes: number;
  files: Array<{
    name: string;
    bytes: number;
    modifiedAt: number;
    family: 'application' | 'codex' | 'other';
    active: boolean;
  }>;
  policy: LogRetentionPolicy;
}
async function storageRequest<T>(
  path: string,
  input?: RequestInit,
): Promise<T> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(`/api/logs/${path}`), {
    ...input,
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
export function readLogStorage() {
  return storageRequest<LogStorage>('storage');
}
export function saveLogRetention(policy: LogRetentionPolicy) {
  return storageRequest<{ policy: LogRetentionPolicy }>('retention', {
    method: 'PUT',
    body: JSON.stringify(policy),
  });
}

export interface LogEntry {
  timestamp: string;
  level: string;
  source: string;
  message: string;
  fields: Record<string, unknown>;
}

export interface LogsResponse {
  data: LogEntry[];
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  availableLevels: string[];
  availableSources: string[];
}

export async function readLogs(input: {
  offset: number;
  limit: number;
  levels: string[];
  sources: string[];
}): Promise<LogsResponse> {
  const query = new URLSearchParams({
    offset: String(input.offset),
    limit: String(input.limit),
  });
  if (input.levels.length) query.set('levels', input.levels.join(','));
  if (input.sources.length) query.set('sources', input.sources.join(','));
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(`/api/logs?${query}`), {
    headers: authorization ? { Authorization: authorization } : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as LogsResponse & {
    message?: string;
  };
  if (!response.ok)
    throw new Error(payload.message || `HTTP ${response.status}`);
  return payload;
}
