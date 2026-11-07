import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
export interface IntegrityIssue {
  id: string;
  kind: string;
  path: string;
  entityId?: string;
  severity: 'error' | 'warning';
  action:
    | 'create-directory'
    | 'realign-agent'
    | 'realign-override'
    | 'select-project-folder'
    | null;
  trash?: { name: string };
  expectedPath?: string;
  reference?: {
    contextType: 'agent' | 'task' | 'deliverable' | 'simple_chat';
    contextId: string;
    label: string;
    resourceId: string;
    relativePath: string;
  };
}
export interface IntegrityReport {
  projectId: string;
  name: string;
  root: string;
  inspectedAt: number;
  fingerprint: string;
  issues: IntegrityIssue[];
  limited: boolean;
  counts: { documents: number; versions: number; copies: number };
}
export async function integrityRequest<T>(
  path = '',
  body?: unknown,
): Promise<T> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath('/api/project-integrity' + path), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  if (!response.ok)
    throw new Error(response.status === 409 ? 'changed' : 'failed');
  return response.json() as Promise<T>;
}
