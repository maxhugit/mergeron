'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtemp,
  writeFile,
  symlink,
  rm,
  readFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { generation } = require('./preview-next-state.cjs');
const { nextAdapterArchive, files } = require('./preview-next-adapter.cjs');
const { entries } = require('./preview-archive.cjs');
const uuid = '11111111-1111-4111-8111-111111111111';
test('reads bounded regular receipt files without following symlinks or trusting invalid generations', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'next-receipt-'));
  try {
    const file = path.join(folder, 'receipt');
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, generation: uuid }),
    );
    assert.equal(generation(file), uuid);
    await symlink(file, file + '-link');
    assert.equal(generation(file + '-link'), null);
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, generation: '<script>' }),
    );
    assert.equal(generation(file), null);
    await writeFile(file, 'x'.repeat(16385));
    assert.equal(generation(file), null);
    assert.equal(generation(folder), null);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('adds a generation to actual transformed CSS and declares the receipt dependency', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'next-css-'));
  try {
    const file = path.join(folder, 'receipt');
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, generation: uuid }),
    );
    const dependencies = [];
    const context = {
      getOptions: () => ({ receiptPath: file }),
      addDependency: (value) => dependencies.push(value),
    };
    const loader = require('./preview-next-css-loader.cjs');
    assert.equal(
      loader.call(context, '#probe{width:32px}'),
      `#probe{width:32px}\n:root{--mergeron-preview-generation:"${uuid}"}\n`,
    );
    assert.deepEqual(dependencies, [file]);
    await writeFile(file, '{}');
    assert.equal(loader.call(context, 'body{}'), 'body{}');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('preserves object/function configuration, origin restrictions and existing webpack hooks outside diagnostics', async () => {
  const { withMergeronPreview } = await import('./preview-next-config.mjs');
  let called = 0;
  const input = {
    allowedDevOrigins: ['specific.preview.example'],
    webpack(config) {
      called++;
      config.preserved = true;
      return config;
    },
  };
  for (const configuration of [input, () => input, async () => input]) {
    const wrapped = withMergeronPreview(configuration);
    const value =
      typeof wrapped === 'function' ? await wrapped('phase', {}) : wrapped;
    assert.deepEqual(value.allowedDevOrigins, input.allowedDevOrigins);
    const result = value.webpack({}, { dev: false });
    assert.equal(result.preserved, true);
  }
  assert.equal(called, 3);
});
test('downloads only fixed public adapter sources as regular tar files and ships every source', async () => {
  const archive = gunzipSync(nextAdapterArchive());
  const unpacked = entries(archive);
  assert.equal(unpacked.length, 6);
  assert.deepEqual(
    unpacked.map((entry) => entry.name).sort(),
    files
      .map((file) => (file === 'preview-next-readme.txt' ? 'README.txt' : file))
      .sort(),
  );
  for (const file of ['Dockerfile', 'manager/test/Dockerfile.previews']) {
    const dockerfile = await readFile(path.join(__dirname, '..', file), 'utf8');
    for (const source of [...files, 'preview-next-adapter.cjs'])
      assert.ok(
        dockerfile.includes(`runtime/${source}`),
        `${file} must ship ${source}`,
      );
  }
});

test('adds only the exact Manager hostname in active development integration and rejects wildcards', async () => {
  const { withMergeronPreview } = await import('./preview-next-config.mjs');
  const keys = [
    'NODE_ENV',
    'MERGERON_PREVIEW_RECEIPT_PATH',
    'MERGERON_NEXT_DIAGNOSTICS_STATE_PATH',
    'MERGERON_PREVIEW_PUBLIC_HOST',
  ];
  const previous = keys.map((key) => process.env[key]);
  try {
    Object.assign(process.env, {
      NODE_ENV: 'development',
      MERGERON_PREVIEW_RECEIPT_PATH: '/fixture/receipt',
      MERGERON_NEXT_DIAGNOSTICS_STATE_PATH: '/fixture/state',
      MERGERON_PREVIEW_PUBLIC_HOST: 'specific.preview.example',
    });
    const config = { allowedDevOrigins: ['existing.example'] };
    assert.deepEqual(withMergeronPreview(config).allowedDevOrigins, [
      'existing.example',
      'specific.preview.example',
    ]);
    for (const host of [
      '*.preview.example',
      'https://preview.example',
      'preview.example:443',
      'preview.example/path',
      'localhost',
    ]) {
      process.env.MERGERON_PREVIEW_PUBLIC_HOST = host;
      assert.deepEqual(withMergeronPreview(config).allowedDevOrigins, [
        'existing.example',
      ]);
    }
    process.env.NODE_ENV = 'production';
    process.env.MERGERON_PREVIEW_PUBLIC_HOST = 'specific.preview.example';
    assert.deepEqual(withMergeronPreview(config).allowedDevOrigins, [
      'existing.example',
    ]);
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});
