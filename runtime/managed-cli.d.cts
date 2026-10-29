export interface Selection {
  version: string | null;
  previous: string | null;
  protection?: {
    schema: 1;
    capabilities: string[];
    approved: Record<string, string>;
  };
}
export interface Manifest {
  schema: 1;
  id: string;
  upstreamVersion: string;
  revision: number;
  upstreamCommit: string;
  patchSha256: string;
  platform: 'linux';
  arch: 'x64';
  capabilities: string[];
  native: string;
  manifestSha256: string;
  files: { path: string; bytes: number; sha256: string; executable: boolean }[];
}
declare const runtime: {
  RELEASE_ID: RegExp;
  REQUIRED_CAPABILITY: string;
  root(home: string): string;
  binary(home: string, id: string): string;
  selection(home: string): Selection;
  selected(home: string): string | null;
  relativeFile(name: string): string;
  within(directory: string, name: string): string;
  hashFile(file: string): string;
  manifest(directory: string, expectedHash?: string): Manifest;
  verify(directory: string, expectedHash?: string): Manifest;
  legacyCustom(home: string, state?: Selection): boolean;
  approvedSelection(
    home: string,
    candidate: { id: string; manifestSha256: string },
  ): Selection;
};
export default runtime;
