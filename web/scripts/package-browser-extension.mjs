// Deterministic store-only ZIP; no dependency, build-time credentials or remote code.
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const files = [
  'manifest.json',
  'browser-api.js',
  'worker.js',
  'protocol.js',
  'bridge.js',
  'tab-agent.js',
  'popup.html',
  'popup.js',
  'options.html',
  'options.js',
  'style.css',
  'README.txt',
];
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function packageExtension(target) {
  const entries = [],
    directory = [];
  let offset = 0;
  for (const name of files) {
    const path = new URL(`../browser-extension/${name}`, import.meta.url);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000)
      throw Error('Invalid extension asset');
    let data = await readFile(path);
    if (name === 'manifest.json' && target === 'safari') {
      const manifest = JSON.parse(data.toString('utf8'));
      delete manifest.minimum_chrome_version;
      manifest.name = 'Mergeron — navigateur local Safari Mac (préversion)';
      manifest.browser_specific_settings = {
        safari: { strict_min_version: '18.4' },
      };
      data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    }
    const filename = Buffer.from(name),
      crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    entries.push(local, filename, data);
    directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  const output = new URL(
    target === 'safari'
      ? '../public/mergeron-browser-extension-safari.zip'
      : '../public/mergeron-browser-extension.zip',
    import.meta.url,
  );
  await mkdir(fileURLToPath(new URL('../public/', import.meta.url)), {
    recursive: true,
  });
  await writeFile(output, Buffer.concat([...entries, central, end]));
}
await packageExtension('chromium');
await packageExtension('safari');
