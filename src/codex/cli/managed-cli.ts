/** Persistent CLI selection. Only validated release IDs become filesystem paths. */
import runtime from '../../../runtime/managed-cli.cjs';

export const CLI_VERSION = /^\d+\.\d+\.\d+$/;
export interface CliSelection {
  version: string | null;
  previous: string | null;
  protection?: {
    schema: 1;
    capabilities: string[];
    approved: Record<string, string>;
  };
}
export function cliRoot(home: string): string {
  return runtime.root(home);
}
export function cliBinary(home: string, version: string): string {
  return runtime.binary(home, version);
}
export function cliSelection(home: string): CliSelection {
  return runtime.selection(home);
}
export const selectedCli = (home: string): string | null =>
  runtime.selected(home);
export const hasCustomCli = (home: string): boolean =>
  Boolean(cliSelection(home).protection || runtime.legacyCustom(home));
export const approveCli = (
  home: string,
  candidate: { id: string; manifestSha256: string },
): CliSelection => runtime.approvedSelection(home, candidate);
export const verifyCliRelease = (directory: string, hash: string) =>
  runtime.verify(directory, hash);
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!CLI_VERSION.test(candidate) || !CLI_VERSION.test(current)) return false;
  const a = candidate.split('.').map(Number),
    b = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}
