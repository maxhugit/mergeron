import { getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
export async function browserApi<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const authorization = getAuthorizationHeader();
  const response = await fetch(withBasePath(`/api/browser${path}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Browser HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
