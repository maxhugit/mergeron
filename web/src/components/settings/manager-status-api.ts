import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

export interface InstalledBuild {
  version: string | null;
  revision: string | null;
  builtAt: string | null;
  channel: 'edge' | 'stable' | 'unknown';
}

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
  id: 'application' | 'ingress' | 'egress' | 'browser';
  displayName: string;
  state: ManagerComponentState;
  adoption: 'managed' | 'adoptable' | 'missing' | 'conflict';
  containerId: string | null;
  containerName: string | null;
  image: string | null;
  imageId?: string | null;
  build?: InstalledBuild | null;
  imageRepositoryAllowed: boolean | null;
  health: string | null;
  restartCount: number;
  configuration?: {
    user: string | null;
    readOnlyRoot: boolean;
    restartPolicy: string | null;
    networkMode: string | null;
    dns?: string[];
    environment: { name: string; value: string | null }[];
  };
  networks: string[];
  missingNetworks: string[];
  protectedMounts: Omit<ManagerProtectedMount, 'component'>[];
}

export type ManagerBackupPolicy =
  | 'full-v1'
  | 'minimal-v1'
  | 'none-v1'
  | 'development-none-v1'
  | 'production-essential-v1'
  | 'legacy-full-v1';

export interface ManagerStatus {
  manager?: { build: InstalledBuild; imageId: string } | null;
  backupPolicy?: ManagerBackupPolicy;
  capabilities?: {
    updateHistory?: boolean;
    backupRestore?: boolean;
    backupManagement?: boolean;
    backupRetention?: boolean;
    backupSelection?: boolean;
  };
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
      startedAt?: string;
      finishedAt?: string | null;
      actor?: { id: string; name: string | null } | null;
      builds?: Record<string, { from: InstalledBuild; to: InstalledBuild }>;
      restoreSource?: string | null;
      checkpoint?: boolean;
      hostObservation?: boolean;
      status:
        | 'running'
        | 'succeeded'
        | 'rolledBack'
        | 'recoveryRequired'
        | 'cancelled';
      phase: string;
      error?: string;
      backupRetained: boolean;
      backupPolicy?: ManagerBackupPolicy;
      rollbackAvailable?: boolean;
      images: Record<string, string>;
      previousImages: Record<string, string>;
      events: { at: string; phase: string; status: string }[];
    };
  };
}

export interface ManagerUpdatePlan {
  backupFormat?: 'tar-gzip-v1' | null;
  backupMode?: 'full' | 'minimal' | 'none';
  backupPolicy?: ManagerBackupPolicy;
  backupScope?: string[];
  excludedFromDataRollback?: string[];
  confirmation?:
    | 'UPDATE_WITHOUT_DATA_BACKUP'
    | 'UPDATE_WITH_ROLLBACK'
    | 'RESTORE_SAVED_STATE'
    | 'CREATE_BACKUP';
  mode?: 'standard';
  restoreSource?: string;
  restorePolicy?: ManagerBackupPolicy;
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
  action:
    | 'plan'
    | 'apply'
    | 'rollback'
    | 'recover'
    | 'restore-plan'
    | 'restore'
    | 'checkpoint-plan'
    | 'checkpoint',
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
  build?: InstalledBuild | null;
  format?: 'directory' | 'tar-gzip-v1' | null;
  backupPolicy?: ManagerBackupPolicy | null;
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
  path: 'backups' | 'backups/delete' | 'backups/retention' | 'update/history',
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
export const managerHistoryKey = ['administration', 'manager-update-history'];
export function requestManagerHistory() {
  return backupRequest<{ operations: ManagerUpdateOperation[] }>(
    'update/history',
  );
}
export function deleteManagerBackup(id: string) {
  return backupRequest<{ ok: boolean }>('backups/delete', {
    operationId: id,
    confirmation: 'DELETE_UPDATE_BACKUP',
  });
}

export const managerRetentionQueryKey = [
  'administration',
  'manager-backup-retention',
];
export function requestManagerRetention() {
  return backupRequest<{ maxBackups: number }>('backups/retention');
}
export function saveManagerRetention(maxBackups: number) {
  return backupRequest<{ maxBackups: number }>('backups/retention', {
    maxBackups,
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
