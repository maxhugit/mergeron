'use strict';
// Shared wire validation. Requests never supply Docker specs, mounts or images.
const crypto = require('node:crypto');
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const RUN_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function invalid() {
  throw new Error('PREVIEW_INVALID_CONFIGURATION');
}
function object(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    invalid();
}
function text(value, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    invalid();
  return value;
}
function integer(value, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) invalid();
  return value;
}
function directory(value = '.') {
  if (value === '.') return value;
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value
      .split('/')
      .some((p) => !p || p === '.' || p === '..' || !/^[\w.@ -]+$/.test(p))
  )
    invalid();
  return value;
}
function environment(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  object(value, Object.keys(value));
  if (Object.keys(value).length > 40) invalid();
  const output = {};
  for (const [key, v] of Object.entries(value)) {
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) ||
      /^(?:HOME|PATH|LD_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_OPTIONS|DOCKER_.*|MERGERON_PREVIEW_.*)$/.test(
        key,
      )
    )
      invalid();
    output[key] = text(v, 4096);
  }
  return output;
}
function profile(value) {
  object(value, [
    'enabled',
    'runtime',
    'directory',
    'install',
    'build',
    'start',
    'port',
    'path',
    'env',
    'memoryMb',
    'cpus',
    'lifetimeMinutes',
    'services',
    'updateMode',
  ]);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    invalid();
  const runtime = text(value.runtime, 40, 'node');
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(runtime)) invalid();
  const path = text(value.path, 500, '/');
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n#]/.test(path))
    invalid();
  const services = value.services ?? [];
  if (!Array.isArray(services) || services.length > 3) invalid();
  const names = new Set();
  const updateMode = value.updateMode ?? 'hot';
  if (!['hot', 'restart', 'manual'].includes(updateMode)) invalid();
  const parsedServices = services.map((s) => {
    object(s, ['name', 'runtime', 'command', 'env']);
    if (
      !/^[a-z][a-z0-9-]{0,30}$/.test(s.name) ||
      ['app', 'egress', 'relay', 'browser'].includes(s.name) ||
      names.has(s.name)
    )
      invalid();
    names.add(s.name);
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(s.runtime)) invalid();
    return {
      name: s.name,
      runtime: s.runtime,
      command: text(s.command, 8000),
      env: environment(s.env),
    };
  });
  const result = {
    enabled: value.enabled ?? false,
    updateMode,
    runtime,
    directory: directory(value.directory),
    install: text(value.install, 8000),
    build: text(value.build, 8000),
    start: text(value.start, 8000),
    port: integer(value.port, 1024, 65535, 3000),
    path,
    env: environment(value.env),
    memoryMb: integer(value.memoryMb, 128, 4096, 1024),
    cpus: integer(value.cpus, 1, 4, 1),
    lifetimeMinutes: integer(value.lifetimeMinutes, 5, 240, 60),
    services: parsedServices,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 96 * 1024) invalid();
  return result;
}
function fingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}
function safeProfile(value) {
  const p = profile(value);
  return {
    ...p,
    env: Object.fromEntries(Object.keys(p.env).map((k) => [k, '[stored]'])),
    services: p.services.map((s) => ({
      ...s,
      env: Object.fromEntries(Object.keys(s.env).map((k) => [k, '[stored]'])),
    })),
  };
}
module.exports = { ID, RUN_ID, profile, directory, fingerprint, safeProfile };
