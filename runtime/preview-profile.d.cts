export interface PreviewProfile {
  enabled: boolean;
  agentManaged: boolean;
  agentRuntimes: string[];
  updateMode: 'hot' | 'restart' | 'manual';
  runtime: string;
  directory: string;
  install: string;
  build: string;
  start: string;
  port: number;
  path: string;
  env: Record<string, string>;
  memoryMb: number;
  cpus: number;
  lifetimeMinutes: number;
  services: {
    name: string;
    runtime: string;
    command: string;
    env: Record<string, string>;
  }[];
}
export type AgentPreviewRecipe = Pick<
  PreviewProfile,
  | 'runtime'
  | 'directory'
  | 'install'
  | 'build'
  | 'start'
  | 'port'
  | 'path'
  | 'env'
  | 'services'
  | 'updateMode'
>;
declare const value: {
  ID: RegExp;
  RUN_ID: RegExp;
  profile(input: unknown): PreviewProfile;
  directory(input?: unknown): string;
  fingerprint(input: unknown): string;
  safeProfile(input: unknown): PreviewProfile;
  agentRecipe(input: unknown): AgentPreviewRecipe;
  agentProfile(policy: PreviewProfile, input: unknown): PreviewProfile;
};
export default value;
