// Disposable Manager entrypoint only. Never copied into the runtime image.
import { open, readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.MERGERON_STACK_PREFIX, 'manager-restart-fixture');
assert.equal(process.env.MERGERON_MANAGER_HOST_STATE, '/fixture/synthetic');
await mkdir('/fixture', { recursive: true });
let first = false;
try {
  const marker = await open('/fixture/durable-marker', 'wx', 0o600);
  await marker.writeFile('synthetic-state-preserved');
  await marker.sync();
  await marker.close();
  const directory = await open('/fixture', 'r');
  await directory.sync();
  await directory.close();
  first = true;
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
assert.equal(
  await readFile('/fixture/durable-marker', 'utf8'),
  'synthetic-state-preserved',
);
const codeRoot = process.env.MERGERON_LOAD_CODE_ROOT ?? '/opt/mergeron-manager';
assert.ok(['/opt/mergeron-manager', '/fixture/manager'].includes(codeRoot));
await import(pathToFileURL(`${codeRoot}/src/server.mjs`).href);
console.log(
  JSON.stringify({
    event: 'managerRestartFixtureBoot',
    first,
    persistentMarkerValid: true,
  }),
);
if (first) {
  // Docker must have observed a successful >10s start before this unexpected exit.
  setTimeout(() => process.exit(23), 12000);
}
