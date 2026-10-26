import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

export type ManagerComponentState =
  | 'missing'
  | 'conflict'
  | 'created'
  | 'stopped'
  | 'running'
  | 'starting'
  | 'healthy'
  | 'unhealthy';

export interface ManagerProtectedMount {
  component: string;
  target: string;
  purpose: string;
  present: boolean;
  source: string | null;
  type: string | null;
  writable: boolean;
}

export interface ManagerComponent {
  id: 'application' | 'ingress' | 'egress';
  displayName: string;
  state: ManagerComponentState;
  adoption: 'managed' | 'adoptable' | 'missing' | 'conflict';
  containerId: string | null;
  containerName: string | null;
  image: string | null;
  imageId?: string | null;
  imageRepositoryAllowed: boolean | null;
  health: string | null;
  restartCount: number;
  configuration?: {
    user: string | null;
    readOnlyRoot: boolean;
    restartPolicy: string | null;
    networkMode: string | null;
    environment: { name: string; value: string | null }[];
  };
  networks: string[];
  missingNetworks: string[];
  protectedMounts: Omit<ManagerProtectedMount, 'component'>[];
}

export interface ManagerStatus {
  capabilities?: { backupManagement?: boolean };
  available: boolean;
  schemaVersion?: number;
  stack?: string;
  environment?: 'production' | 'development';
  mode: 'observe';
  observedAt?: string;
  dockerConnected: boolean;
  components: ManagerComponent[];
  dataSafety: {
    status: 'protected' | 'blocked' | 'unknown';
    blockers: string[];
    protectedMounts: ManagerProtectedMount[];
  };
  adoption?: {
    state: 'eligible' | 'blocked' | 'adopted' | 'drifted';
    fingerprint: string;
    adoptedAt: string | null;
    blockers: string[];
    canAdopt: boolean;
  };
  error?: string;
  update?: {
    busy: boolean;
    operation: null | {
      id: string;
      status: 'running' | 'succeeded' | 'rolledBack' | 'recoveryRequired';
      phase: string;
      error?: string;
      backupRetained: boolean;
      images: Record<string, string>;
      previousImages: Record<string, string>;
      events: { at: string; phase: string; status: string }[];
    };
  };
}

export interface ManagerUpdatePlan {
  fingerprint: string;
  applicable: boolean;
  blockers: string[];
  images: Record<string, string>;
}

export type ManagerUpdateState = NonNullable<ManagerStatus['update']>;
export type ManagerUpdateOperation = NonNullable<
  ManagerUpdateState['operation']
>;

export async function requestManagerUpdate(
  action: 'plan' | 'apply' | 'rollback' | 'recover',
  input: Record<string, unknown>,
): Promise<ManagerUpdatePlan | ManagerUpdateState> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(
    withBasePath(
      `/api/settings/manager/update${action === 'apply' ? '' : `/${action}`}`,
    ),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(input),
    },
  );
  const data = (await response.json()) as (
    | ManagerUpdatePlan
    | ManagerUpdateState
  ) & {
    message?: string;
    error?: string;
  };
  if (!response.ok)
    throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`);
  return data;
}

export const managerStatusQueryKey = ['administration', 'manager-status'];

export interface ManagerBackup {
  id: string;
  path?: string | null;
  managerPath?: string;
  sizeBytes?: number | null;
  sizeStatus?: 'calculating' | 'ready' | 'unavailable';
  createdAt: string;
  status: string;
  current: boolean;
  restorable: boolean;
  canDelete: boolean;
  protectionReason: string | null;
}
export const managerBackupsQueryKey = ['administration', 'manager-backups'];
async function backupRequest<T>(
  path: 'backups' | 'backups/delete',
  body?: Record<string, unknown>,
): Promise<T> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(`/api/settings/manager/${path}`), {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = (await response.json()) as T & {
    message?: string;
    error?: string;
  };
  if (!response.ok)
    throw new Error(
      result.message ?? result.error ?? 'managerBackupsUnavailable',
    );
  return result;
}
export function requestManagerBackups() {
  return backupRequest<{
    backups: ManagerBackup[];
    totalSizeBytes?: number | null;
    sizesCalculating?: boolean;
  }>('backups');
}
export function deleteManagerBackup(id: string) {
  return backupRequest<{ ok: boolean }>('backups/delete', {
    operationId: id,
    confirmation: 'DELETE_UPDATE_BACKUP',
  });
}

export async function requestManagerStatus(): Promise<ManagerStatus> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath('/api/settings/manager/status'), {
    headers: authorization ? { Authorization: authorization } : {},
  });
  const data = (await response.json()) as ManagerStatus & {
    message?: string | string[];
  };
  if (!response.ok) {
    const message = Array.isArray(data.message)
      ? data.message.join('\n')
      : data.message;
    throw new Error(message ?? `HTTP ${response.status}`);
  }
  return data;
}

export async function requestManagerAdoption(
  expectedFingerprint: string,
): Promise<ManagerStatus> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath('/api/settings/manager/adopt'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      confirmation: 'ADOPT_EXISTING_INSTALLATION',
      expectedFingerprint,
    }),
  });
  const data = (await response.json()) as ManagerStatus & {
    error?: string;
    message?: string | string[];
  };
  if (!response.ok) {
    const message = Array.isArray(data.message)
      ? data.message.join('\n')
      : data.message;
    throw new Error(message ?? data.error ?? `HTTP ${response.status}`);
  }
  return data;
}
