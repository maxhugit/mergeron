'use strict';
// Deliberately narrow USTAR: no PAX, sparse files, links, devices or extensions.
const crypto = require('node:crypto');
const decoder = new TextDecoder('utf-8', { fatal: true });
function fail() {
  throw new Error('PREVIEW_UNSAFE_ARCHIVE');
}
function safeName(name) {
  if (
    typeof name !== 'string' ||
    Buffer.byteLength(name) > 240 ||
    /[\x00-\x1f\\]/.test(name) ||
    name
      .split('/')
      .some((p) => !p || p === '.' || p === '..' || p.startsWith('.mergeron'))
  )
    fail();
  return name;
}
function string(b) {
  const i = b.indexOf(0);
  return decoder.decode(i < 0 ? b : b.subarray(0, i));
}
function number(b) {
  const s = string(b).trim();
  if (!/^[0-7]+$/.test(s)) fail();
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n) || n < 0) fail();
  return n;
}
function entries(archive) {
  if (
    !Buffer.isBuffer(archive) ||
    archive.length > 64 * 1024 ** 2 ||
    archive.length % 512
  )
    fail();
  const result = [],
    names = new Set();
  let offset = 0,
    bytes = 0,
    ended = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((v) => v === 0)) {
      if (
        !archive.subarray(offset).every((v) => v === 0) ||
        archive.length - offset < 1024
      )
        fail();
      ended = true;
      break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (
      number(header.subarray(148, 156)) !== sum ||
      string(header.subarray(257, 263)) !== 'ustar'
    )
      fail();
    const type =
      header[156] === 53
        ? 'directory'
        : header[156] === 48 || header[156] === 0
          ? 'file'
          : fail();
    const prefix = string(header.subarray(345, 500));
    let name = (prefix ? prefix + '/' : '') + string(header.subarray(0, 100));
    if (type === 'directory') name = name.replace(/\/$/, '');
    const size = number(header.subarray(124, 136)),
      mode = number(header.subarray(100, 108));
    if (
      number(header.subarray(108, 116)) !== 11002 ||
      number(header.subarray(116, 124)) !== 11002 ||
      (mode !== 0o600 && mode !== 0o700)
    )
      fail();
    if (
      (type === 'directory' && size !== 0) ||
      size > 16 * 1024 ** 2 ||
      offset + 512 + size > archive.length
    )
      fail();
    if (!(name === '.' && type === 'directory')) {
      safeName(name);
      if (names.has(name) || names.size >= 15000) fail();
      names.add(name);
      bytes += size;
      if (bytes > 50 * 1024 ** 2) fail();
      result.push({
        name,
        type,
        mode: type === 'directory' || mode & 0o111 ? 0o700 : 0o600,
        sha256:
          type === 'file'
            ? crypto
                .createHash('sha256')
                .update(archive.subarray(offset + 512, offset + 512 + size))
                .digest('hex')
            : null,
      });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || !result.some((v) => v.type === 'file')) fail();
  return result;
}
function jsonArchive(value, name = 'spec.json') {
  if (!['spec.json', 'ready'].includes(name)) fail();
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > 8 * 1024 ** 2) fail();
  const header = Buffer.alloc(512);
  const put = (value, at, length) => header.write(value, at, length, 'ascii');
  const octal = (n, length) => n.toString(8).padStart(length - 1, '0') + '\0';
  put(name, 0, 100);
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
      .reduce((s, v) => s + v, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
    8,
  );
  return Buffer.concat([
    header,
    data,
    Buffer.alloc(((512 - (data.length % 512)) % 512) + 1024),
  ]);
}
module.exports = { entries, safeName, jsonArchive };
