import type { ManagerBackupPolicy } from './manager-status-api';

export const withoutDataBackup = (policy?: ManagerBackupPolicy) =>
  policy === 'none-v1' || policy === 'development-none-v1';

export function backupDescription(policy?: ManagerBackupPolicy) {
  switch (policy) {
    case 'full-v1':
      return 'managerFullBackupHelp';
    case 'minimal-v1':
      return 'managerMinimalBackupHelp';
    case 'none-v1':
      return 'managerNoBackupHelp';
    case 'development-none-v1':
      return 'managerDevelopmentNoBackup';
    case 'production-essential-v1':
      return 'managerProductionEssentialBackup';
    default:
      return 'managerLegacyFullBackup';
  }
}

export function backupLabel(policy?: ManagerBackupPolicy) {
  if (withoutDataBackup(policy)) return 'managerNoBackup';
  if (policy === 'minimal-v1') return 'managerMinimalBackup';
  if (policy === 'full-v1') return 'managerFullBackup';
  return policy === 'production-essential-v1'
    ? 'managerBackupEssentialLabel'
    : 'managerBackupFullLabel';
}
