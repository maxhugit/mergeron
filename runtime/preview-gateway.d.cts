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
}
export class PreviewGateway {
  constructor(input: {
    domain: string;
    authorize(grant: PreviewGrant): Promise<PreviewTransport>;
    now?: () => number;
  });
  server: import('node:http').Server;
  mint(
    grant: PreviewGrant,
    path?: string,
  ): Promise<{ url: string; expiresAt: number }>;
  close(): Promise<void>;
}
