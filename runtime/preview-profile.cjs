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
      /^(?:HOME|PATH|TMPDIR|XDG_CACHE_HOME|XDG_DATA_HOME|COREPACK_HOME|PNPM_HOME|LD_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_OPTIONS|NODE_USE_ENV_PROXY|DOCKER_.*|MERGERON_PREVIEW_.*)$/.test(
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
    'agentManaged',
    'agentRuntimes',
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
  if (
    value.agentManaged !== undefined &&
    typeof value.agentManaged !== 'boolean'
  )
    invalid();
  const runtime = text(value.runtime, 40, 'node');
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(runtime)) invalid();
  const agentRuntimes = value.agentRuntimes ?? [runtime];
  if (
    !Array.isArray(agentRuntimes) ||
    agentRuntimes.length > 16 ||
    new Set(agentRuntimes).size !== agentRuntimes.length ||
    agentRuntimes.some(
      (id) => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(id),
    )
  )
    invalid();
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
    agentManaged: value.agentManaged ?? false,
    agentRuntimes,
    updateMode,
    runtime,
    directory: directory(value.directory),
    install: text(value.install, 8000),
    build: text(value.build, 8000),
    start: text(value.start, 8000),
    port: integer(value.port, 1024, 65535, 3000),
    path,
    env: environment(value.env),
    memoryMb: integer(value.memoryMb, 128, 8192, 1024),
    cpus: integer(value.cpus, 1, 4, 1),
    // Preserve historical minute values when reading stored profiles.
    lifetimeMinutes:
      value.lifetimeMinutes === null
        ? null
        : LIFETIME_MINUTES.includes(value.lifetimeMinutes)
          ? value.lifetimeMinutes
          : integer(value.lifetimeMinutes, 5, 240, 300),
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
// Agent recipes cannot enable their project, select images/mounts, alter the
// network, import stored project secrets or raise human-approved resource caps.
function agentRecipe(value) {
  object(value, [
    'runtime',
    'directory',
    'install',
    'build',
    'start',
    'port',
    'path',
    'env',
    'services',
    'updateMode',
  ]);
  const parsed = profile(value);
  if (!parsed.start.trim()) invalid();
  if (
    [
      ...Object.values(parsed.env),
      ...parsed.services.flatMap((s) => Object.values(s.env)),
    ].includes('[stored]')
  )
    invalid();
  return Object.fromEntries(
    [
      'runtime',
      'directory',
      'install',
      'build',
      'start',
      'port',
      'path',
      'env',
      'services',
      'updateMode',
    ].map((k) => [k, parsed[k]]),
  );
}
function agentProfile(policy, input) {
  const approved = profile(policy),
    recipe = agentRecipe(input);
  if (!approved.enabled || !approved.agentManaged)
    throw Error('PREVIEW_AGENT_NOT_AUTHORIZED');
  if (
    [recipe.runtime, ...recipe.services.map((s) => s.runtime)].some(
      (id) => !approved.agentRuntimes.includes(id),
    )
  )
    throw Error('PREVIEW_RUNTIME_NOT_ALLOWED');
  return profile({
    ...recipe,
    enabled: true,
    memoryMb: approved.memoryMb,
    cpus: approved.cpus,
    lifetimeMinutes: approved.lifetimeMinutes,
  });
}
const LIFETIME_MINUTES = Object.freeze([60, 180, 300, 600, 1440, null]);
function lifetime(value) {
  if (!LIFETIME_MINUTES.includes(value)) invalid();
  return value;
}
module.exports = {
  LIFETIME_MINUTES,
  lifetime,
  ID,
  RUN_ID,
  profile,
  directory,
  fingerprint,
  safeProfile,
  agentRecipe,
  agentProfile,
};
