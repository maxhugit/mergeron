'use strict';
/** Fixed, non-secret source bundle. No request-controlled paths or archive names. */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { gzipSync } = require('node:zlib');
const files = [
  'preview-next-state.cjs',
  'preview-next-css-loader.cjs',
  'preview-next-config.mjs',
  'preview-next-client.cjs',
  'preview-next-server.mjs',
  'preview-next-readme.txt',
];
function nextAdapterArchive() {
  const chunks = [];
  for (const name of files) {
    const data = readFileSync(join(__dirname, name));
    if (data.length > 128 * 1024) throw Error('PREVIEW_ADAPTER_SIZE_LIMIT');
    const header = Buffer.alloc(512);
    const put = (v, offset, size) => header.write(v, offset, size, 'ascii');
    const octal = (v, size) => v.toString(8).padStart(size - 1, '0') + '\0';
    put(name === 'preview-next-readme.txt' ? 'README.txt' : name, 0, 100);
    put(octal(0o600, 8), 100, 8);
    put(octal(11002, 8), 108, 8);
    put(octal(11002, 8), 116, 8);
    put(octal(data.length, 12), 124, 12);
    put(octal(0, 12), 136, 12);
    put('        ', 148, 8);
    put('0', 156, 1);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    put(
      [...header]
        .reduce((sum, v) => sum + v, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
      8,
    );
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
module.exports = { nextAdapterArchive, files };
