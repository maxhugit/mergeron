import { projectsApi } from './projects-api';

export type Options = {
  boardId: string;
  copyId?: string;
  directory: string;
  restrictedIds: string[];
  renameFolders?: boolean;
};
export type Settings = Omit<Options, 'boardId'> & {
  enabled: boolean;
  lastError: string | null;
  lastSyncAt: number | null;
};
export interface Status {
  boards: {
    id: string;
    name: string;
    restricted: { id: string; title: string }[];
    settings: Settings | null;
  }[];
  copies: {
    id: string;
    name: string;
    sourceResourceId?: string;
    ownerThreadIds?: string[];
    localPath?: string | null;
    writable: boolean;
    owned: boolean;
    eligible?: boolean;
    context?: { branch: string | null; head: string | null } | null;
    lastError?: string | null;
    lastSyncAt?: number | null;
    pending?: boolean;
    directory?: string;
  }[];
  discovered: { id: string; title: string; documents: number }[];
  discoveryError: string | null;
  proposal?: Preview | null;
  active?: boolean;
  verifiedAt?: number | null;
}
export type Preview = {
  fingerprint: string;
  context?: { branch: string | null; head: string | null };
  canApply: boolean;
  locations?: {
    deliverableId: string;
    portableId: string;
    title: string;
    folder: string;
  }[];
  changes: {
    deliverable: string;
    deliverableId?: string;
    document?: string;
    documentId?: string;
    action: string;
    reason: string;
  }[];
};
export const url = (p: string) => `/${encodeURIComponent(p)}/git-deliverables`;
export const key = (p: string) => ['git-deliverables', p];
export const suffix = (value: string) =>
  value
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
export const post = <T>(p: string, suffix: string, body: unknown) =>
  projectsApi<T>(url(p) + suffix, {
    method: 'POST',
    body: JSON.stringify(body),
  });
