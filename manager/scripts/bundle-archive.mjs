import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = await build({
  absWorkingDir: root,
  stdin: {
    contents: "module.exports = require('tar-stream');",
    resolveDir: root,
  },
  outfile: join(root, 'vendor/tar-codec.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  metafile: true,
  legalComments: 'linked',
});
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (input === '<stdin>') continue;
  let directory = dirname(resolve(root, input));
  while (directory.startsWith(root) && directory !== root) {
    try {
      const data = JSON.parse(
        await readFile(join(directory, 'package.json'), 'utf8'),
      );
      if (!packages.has(directory)) {
        let license;
        for (const name of [
          'LICENSE',
          'LICENSE.md',
          'LICENSE.txt',
          'license',
        ]) {
          try {
            license = await readFile(join(directory, name), 'utf8');
            break;
          } catch {}
        }
        if (!license) throw Error(`Missing license: ${data.name}`);
        packages.set(directory, `${data.name}@${data.version}\n${license}`);
      }
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      directory = dirname(directory);
    }
  }
}
await writeFile(
  join(root, 'vendor/THIRD-PARTY-NOTICES.txt'),
  [...packages.values()].join('\n\n'),
);
