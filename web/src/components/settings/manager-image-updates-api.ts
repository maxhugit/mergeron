import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';

export interface ComponentImageUpdate {
  id: string;
  displayName: string;
  installedImage: string | null;
  installedDigest: string | null;
  targetImage: string | null;
  targetDigest: string | null;
  versionStatus: 'unknown' | 'current' | 'update_available';
  updateAvailable: boolean;
  notesUrl: string | null;
  checkError: string | null;
  migrationAvailable?: boolean;
}
export const componentUpdatesKey = [
  'administration',
  'component-image-updates',
];
export async function requestComponentUpdates(
  refresh = false,
): Promise<{ checkedAt: string; components: ComponentImageUpdate[] }> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(
    withBasePath(
      `/api/settings/manager/image-updates${refresh ? '?refresh=true' : ''}`,
    ),
    {
      headers: authorization ? { Authorization: authorization } : {},
    },
  );
  if (!response.ok) throw new Error('managerImageDiscoveryUnavailable');
  const value = (await response.json()) as {
    checkedAt: string;
    components: ComponentImageUpdate[];
  };
  if (!Array.isArray(value.components))
    throw new Error('managerImageDiscoveryUnavailable');
  return value;
}
