/** Non-executing mount keeper for the ephemeral, size-limited source volume. */
import fs from 'node:fs';
const root = fs.lstatSync('/target');
if (
  !root.isDirectory() ||
  root.isSymbolicLink() ||
  root.uid !== 11002 ||
  root.gid !== 11002
)
  throw Error('PREVIEW_UNSAFE_VOLUME');
setInterval(() => {}, 60000);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => process.exit(0));
