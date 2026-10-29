import type { Manifest } from './managed-cli.cjs';
declare const testing: {
  bundle(
    parent: string,
    revision?: number,
  ): { directory: string; data: Manifest };
};
export default testing;
