export interface PreviewProfile {
  enabled: boolean;
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
declare const value: {
  ID: RegExp;
  RUN_ID: RegExp;
  profile(input: unknown): PreviewProfile;
  directory(input?: unknown): string;
  fingerprint(input: unknown): string;
  safeProfile(input: unknown): PreviewProfile;
};
export default value;
