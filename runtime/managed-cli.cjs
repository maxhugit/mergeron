/** Shared, offline trust boundary for Manager packages, the app and dispatchers.
 * No downloads, shell execution, credentials or mutable upstream tags here.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const RELEASE_ID = /^\d+\.\d+\.\d+(?:-mergeron\.[1-9]\d{0,5})?$/;
const HASH = /^[a-f0-9]{64}$/;
const REQUIRED_CAPABILITY = 'netlink-route-query-v1';
const cache = new Map();
function fail() {
  throw new Error('codexRuntimeIntegrityInvalid');
}
function root(home) {
  return path.join(home, 'webui', 'cli');
}
function binary(home, id) {
  if (typeof id !== 'string' || !RELEASE_ID.test(id)) fail();
  return path.join(root(home), 'releases', id, 'codex');
}
function regular(file, maxBytes = 1024 ** 3) {
  const value = fs.lstatSync(file);
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 1 ||
    value.size > maxBytes
  )
    fail();
  return value;
}
function json(file, max = 1024 * 1024) {
  regular(file, max);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function selection(home) {
  const file = path.join(root(home), 'selection.json');
  let value;
  try {
    value = json(file, 64 * 1024);
  } catch (error) {
    if (error.code === 'ENOENT') return { version: null, previous: null };
    throw error;
  }
  if (
    !value ||
    [value.version, value.previous].some(
      (id) => id !== null && (typeof id !== 'string' || !RELEASE_ID.test(id)),
    )
  )
    fail();
  if (value.protection !== undefined) {
    const p = value.protection;
    if (
      p?.schema !== 1 ||
      !Array.isArray(p.capabilities) ||
      !p.capabilities.includes(REQUIRED_CAPABILITY) ||
      p.capabilities.some((c) => !/^[a-z0-9-]{1,80}$/.test(c)) ||
      !p.approved ||
      Array.isArray(p.approved) ||
      Object.keys(p.approved).length > 32
    )
      fail();
    for (const [id, hash] of Object.entries(p.approved))
      if (!RELEASE_ID.test(id) || !HASH.test(hash)) fail();
  }
  return {
    version: value.version,
    previous: value.previous,
    ...(value.protection ? { protection: value.protection } : {}),
  };
}
function relativeFile(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 1024 ||
    name.includes('\\') ||
    name.includes('\0') ||
    path.isAbsolute(name) ||
    name.split('/').some((p) => !p || p === '.' || p === '..')
  )
    fail();
  return name;
}
function within(directory, name) {
  relativeFile(name);
  let current = directory;
  for (const part of name.split('/').slice(0, -1)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink()) fail();
  }
  return path.join(directory, name);
}
function hashFile(file) {
  regular(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(128 * 1024);
    let length;
    while ((length = fs.readSync(fd, chunk, 0, chunk.length, null)))
      hash.update(chunk.subarray(0, length));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
function manifest(directory, expectedHash) {
  const rootInfo = fs.lstatSync(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail();
  const file = path.join(directory, 'release.json');
  regular(file, 1024 * 1024);
  const raw = fs.readFileSync(file);
  const digest = createHash('sha256').update(raw).digest('hex');
  if (
    expectedHash !== undefined &&
    (!HASH.test(expectedHash) || digest !== expectedHash)
  )
    fail();
  const data = JSON.parse(raw.toString('utf8'));
  if (
    data.schema !== 1 ||
    !RELEASE_ID.test(data.id) ||
    data.id !== `${data.upstreamVersion}-mergeron.${data.revision}` ||
    !/^[a-f0-9]{40}$/.test(data.upstreamCommit) ||
    !HASH.test(data.patchSha256) ||
    data.platform !== 'linux' ||
    data.arch !== 'x64' ||
    !Array.isArray(data.capabilities) ||
    !data.capabilities.includes(REQUIRED_CAPABILITY) ||
    data.capabilities.some(
      (c) => typeof c !== 'string' || !/^[a-z0-9-]{1,80}$/.test(c),
    ) ||
    !Array.isArray(data.files) ||
    !data.files.length ||
    data.files.length > 4096
  )
    fail();
  relativeFile(data.native);
  const names = new Set();
  let total = 0;
  for (const entry of data.files) {
    relativeFile(entry.path);
    if (
      ['release.json', 'codex', 'helpers'].includes(entry.path.split('/')[0]) ||
      names.has(entry.path) ||
      !HASH.test(entry.sha256) ||
      typeof entry.executable !== 'boolean' ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > 512 * 1024 ** 2
    )
      fail();
    names.add(entry.path);
    total += entry.bytes;
  }
  if (
    !names.has(data.native) ||
    !data.files.find((f) => f.path === data.native).executable ||
    total > 1024 ** 3
  )
    fail();
  return { ...data, manifestSha256: digest };
}
function verify(directory, expectedHash) {
  const data = manifest(directory, expectedHash);
  const stats = data.files
    .map((entry) => {
      const file = within(directory, entry.path);
      const st = regular(file);
      if (
        st.size !== entry.bytes ||
        st.mode & 0o222 ||
        Boolean(st.mode & 0o111) !== entry.executable
      )
        fail();
      return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    })
    .join('|');
  const key = `${directory}:${data.manifestSha256}`;
  if (cache.get(key) !== stats) {
    for (const entry of data.files)
      if (hashFile(within(directory, entry.path)) !== entry.sha256) fail();
    if (cache.size > 8) cache.clear();
    cache.set(key, stats);
  }
  const aliases = {
    codex: data.native,
    ...Object.fromEntries(
      [
        'codex',
        'apply_patch',
        'applypatch',
        'codex-execve-wrapper',
        'codex-linux-sandbox',
      ].map((name) => [`helpers/${name}`, '../codex']),
    ),
  };
  for (const [name, target] of Object.entries(aliases))
    if (
      !fs.lstatSync(path.join(directory, name)).isSymbolicLink() ||
      fs.readlinkSync(path.join(directory, name)) !== target
    )
      fail();
  const expectedNames = new Set([
    'release.json',
    ...data.files.map((f) => f.path),
    ...Object.keys(aliases),
  ]);
  let inspected = 0;
  function inspectTree(base, prefix = '', depth = 0) {
    if (depth > 64) fail();
    for (const item of fs.readdirSync(base, { withFileTypes: true })) {
      if (++inspected > 16384) fail();
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory())
        inspectTree(path.join(base, item.name), name, depth + 1);
      else if (!expectedNames.delete(name)) fail();
    }
  }
  inspectTree(directory);
  if (expectedNames.size) fail();
  return data;
}
function legacyCustom(home, state = selection(home)) {
  if (!state.version) return false;
  try {
    return fs.existsSync(
      path.join(
        path.dirname(fs.realpathSync(binary(home, state.version))),
        'mergeron-netlink-variant.json',
      ),
    );
  } catch {
    return false;
  }
}
function selected(home) {
  const state = selection(home);
  if (!state.version) {
    if (state.protection) fail();
    return null;
  }
  const executable = binary(home, state.version);
  if (state.protection || state.version.includes('-mergeron.')) {
    const expected = state.protection?.approved?.[state.version];
    if (!expected) fail();
    const data = verify(path.dirname(executable), expected);
    if (
      data.id !== state.version ||
      state.protection.capabilities.some((c) => !data.capabilities.includes(c))
    )
      fail();
  }
  return executable;
}
function approvedSelection(home, candidate) {
  const before = selection(home);
  const data = verify(
    path.dirname(binary(home, candidate.id)),
    candidate.manifestSha256,
  );
  if (data.id !== candidate.id) fail();
  const protection = before.protection ?? {
    schema: 1,
    capabilities: [REQUIRED_CAPABILITY],
    approved: {},
  };
  if (protection.capabilities.some((c) => !data.capabilities.includes(c)))
    fail();
  if (
    protection.approved[data.id] &&
    protection.approved[data.id] !== data.manifestSha256
  )
    fail();
  const approved = { ...protection.approved, [data.id]: data.manifestSha256 };
  for (const id of Object.keys(approved)) {
    if (Object.keys(approved).length <= 16) break;
    if (![data.id, before.version, before.previous].includes(id))
      delete approved[id];
  }
  return {
    version: data.id,
    previous: before.version === data.id ? before.previous : before.version,
    protection: {
      ...protection,
      approved,
    },
  };
}
module.exports = {
  RELEASE_ID,
  REQUIRED_CAPABILITY,
  root,
  binary,
  selection,
  relativeFile,
  within,
  hashFile,
  manifest,
  verify,
  legacyCustom,
  selected,
  approvedSelection,
};
