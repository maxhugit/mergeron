/** Non-executing mount keeper for the ephemeral, size-limited source volume. */
import fs from 'node:fs';
import storage from '../../runtime/preview-storage.cjs';
const { storageMounts, storageSample } = storage;
for (const m of storageMounts) {
  const root = fs.lstatSync(m.observerPath);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== 11002 ||
    root.gid !== 11002
  )
    throw Error('PREVIEW_UNSAFE_VOLUME');
}
// Read-only metadata, not a recursive inventory. Retain the final evidence even
// when the application has exited. No network, project code or writable mounts.
function sample() {
  console.log(
    JSON.stringify({
      version: 1,
      checkedAt: Date.now(),
      mounts: storageMounts.map((m) => ({
        role: m.role,
        ...storageSample(fs.statfsSync(m.observerPath)),
      })),
    }),
  );
}
sample();
setInterval(sample, 3000);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => process.exit(0));
