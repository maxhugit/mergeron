import type { PlatformIdentity } from '../src/auth/identity.service';
export interface PreviewGrant {
  previewId: string;
  runId: string;
  projectId: string;
  threadId: string;
  identity: PlatformIdentity;
}
export interface PreviewTransport {
  endpoint: string;
  token: string;
  publicHost: string;
  expiresAt: number;
  receipt?: import('./preview-receipt.cjs').PreviewReceipt | null;
  syncError?: unknown;
}
export class PreviewGateway {
  constructor(input: {
    domain: string;
    mergeronUrl?: string;
    authorize(grant: PreviewGrant): Promise<PreviewTransport>;
    verifySource?(
      grant: PreviewGrant,
      receipt: import('./preview-receipt.cjs').PreviewReceipt,
    ): Promise<boolean | null>;
    now?: () => number;
  });
  server: import('node:http').Server;
  mint(
    grant: PreviewGrant,
    path?: string,
  ): Promise<{ url: string; expiresAt: number }>;
  close(): Promise<void>;
}

export type PreviewAccessReason =
  | 'session_required'
  | 'session_expired'
  | 'permission_denied'
  | 'configuration_changed'
  | 'environment_unavailable'
  | 'upstream_unavailable'
  | 'origin_denied'
  | 'invalid_request'
  | 'unavailable';
export class PreviewAccessError extends Error {
  readonly reason: PreviewAccessReason;
  constructor(reason: PreviewAccessReason);
}
