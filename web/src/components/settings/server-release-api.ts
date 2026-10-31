import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

export interface ServerBuildInfo {
  version: string | null;
  revision: string | null;
  builtAt: string | null;
  channel: 'edge' | 'stable' | 'unknown';
}

export interface ServerReleaseNote {
  version: string;
  publishedAt: string | null;
  url: string;
  sections: { heading: string; items: string[] }[];
}

export interface ServerReleaseStatus {
  targetChannel?: 'edge' | 'stable';
  githubRelease?: {
    version: string | null;
    url: string | null;
    publishedAt: string | null;
  };
  installed: ServerBuildInfo;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  latestUrl: string | null;
  updateAvailable: boolean;
  versionStatus: 'update_available' | 'current' | 'edge' | 'ahead' | 'unknown';
  releases: ServerReleaseNote[];
  checkedAt: string;
  checkError: string | null;
  targetImage?: string;
  targetDigest?: string | null;
  latestRevision?: string | null;
  changesError?: boolean;
  changesTruncated?: boolean;
}

export const serverReleaseQueryKey = ['administration', 'server-release'];

/** Shared cache and polling: sidebar and version card observe the same discovery. */
export const serverReleaseQueryOptions = {
  queryKey: serverReleaseQueryKey,
  queryFn: () => requestServerRelease(),
  staleTime: 60_000,
  refetchInterval: 60_000,
  retry: false,
};

export async function requestServerRelease(
  refresh = false,
): Promise<ServerReleaseStatus> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(
    withBasePath(
      `/api/settings/release/status${refresh ? '?refresh=true' : ''}`,
    ),
    {
      headers: authorization ? { Authorization: authorization } : {},
    },
  );
  const data = (await response.json()) as ServerReleaseStatus & {
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
