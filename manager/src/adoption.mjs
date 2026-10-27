import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const ADOPTION_CONFIRMATION = 'ADOPT_EXISTING_INSTALLATION';

function snapshotComponents(inventory) {
  return [...inventory.components]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((component) => ({
      id: component.id,
      containerId: component.containerId,
      containerName: component.containerName,
      image: component.image,
      networks: [...component.networks].sort(),
      protectedMounts: [...component.protectedMounts]
        .sort((left, right) => left.target.localeCompare(right.target))
        .map((mount) => ({
          target: mount.target,
          source: mount.source,
          type: mount.type,
          writable: mount.writable,
        })),
    }));
}

function canonicalSnapshot(inventory) {
  return {
    schemaVersion: 2,
    stack: inventory.stack,
    environment: inventory.environment,
    components: snapshotComponents(inventory),
  };
}

// PR #103 persisted schema 1 before stack environments existed. Keep its
// exact canonical form so an already adopted production installation remains
// trusted without rewriting or deleting the immutable record.
function legacySnapshot(inventory) {
  return {
    schemaVersion: 1,
    stack: inventory.stack,
    components: snapshotComponents(inventory),
  };
}

function hashSnapshot(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function inventoryFingerprint(inventory) {
  return hashSnapshot(canonicalSnapshot(inventory));
}

function adoptionBlockers(inventory) {
  const blockers = [...inventory.dataSafety.blockers];
  for (const component of inventory.components) {
    if (!component.containerId)
      blockers.push(`${component.id}:containerUnavailable`);
    if (component.imageRepositoryAllowed === false)
      blockers.push(`${component.id}:imageRepositoryNotAllowed`);
    for (const network of component.missingNetworks)
      blockers.push(`${component.id}:${network}:networkMissing`);
  }
  return [...new Set(blockers)].sort();
}

export function evaluateAdoption(inventory, record = null) {
  const fingerprint = inventoryFingerprint(inventory);
  const blockers = adoptionBlockers(inventory);
  const alreadyManaged =
    !record &&
    [3, 4].includes(inventory.components.length) &&
    ['application', 'ingress', 'egress'].every((id) =>
      inventory.components.some((component) => component.id === id),
    ) &&
    inventory.components.every((component) =>
      ['application', 'ingress', 'egress', 'browser'].includes(component.id),
    ) &&
    new Set(inventory.components.map((component) => component.id)).size ===
      inventory.components.length &&
    inventory.components.every((component) => component.adoption === 'managed');
  let state = blockers.length === 0 ? 'eligible' : 'blocked';
  if (record) {
    const currentRecordMatches =
      record.schemaVersion === 2 &&
      record.stack === inventory.stack &&
      record.environment === inventory.environment &&
      record.fingerprint === fingerprint;
    const legacyProductionRecordMatches =
      record.schemaVersion === 1 &&
      record.environment === undefined &&
      inventory.environment === 'production' &&
      record.stack === inventory.stack &&
      record.fingerprint === hashSnapshot(legacySnapshot(inventory));
    state =
      currentRecordMatches || legacyProductionRecordMatches
        ? 'adopted'
        : 'drifted';
    if (state === 'drifted') blockers.push('adoptionRecordDrift');
  }
  return {
    ...inventory,
    components: inventory.components.map((component) => ({
      ...component,
      adoption: state === 'adopted' ? 'managed' : component.adoption,
    })),
    adoption: {
      state,
      fingerprint,
      adoptedAt: state === 'adopted' ? record.adoptedAt : null,
      blockers: [...new Set(blockers)].sort(),
      canAdopt: state === 'eligible' && !alreadyManaged,
    },
  };
}

export async function readAdoptionRecord(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    const commonRecordIsInvalid =
      !value ||
      ![1, 2].includes(value.schemaVersion) ||
      typeof value.stack !== 'string' ||
      typeof value.fingerprint !== 'string' ||
      !Array.isArray(value.components);
    const environmentIsValid =
      value?.schemaVersion === 1
        ? value.environment === undefined
        : ['production', 'development'].includes(value?.environment);
    if (commonRecordIsInvalid || !environmentIsValid)
      throw new Error('Invalid adoption record');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function confirmAdoption({
  inventory,
  existingRecord,
  confirmation,
  expectedFingerprint,
  path,
  now = new Date(),
}) {
  if (confirmation !== ADOPTION_CONFIRMATION)
    throw new Error('adoptionConfirmationRequired');
  const evaluated = evaluateAdoption(inventory, existingRecord);
  if (evaluated.adoption.fingerprint !== expectedFingerprint)
    throw new Error('adoptionInventoryChanged');
  if (!evaluated.adoption.canAdopt) throw new Error('adoptionBlocked');
  const record = {
    ...canonicalSnapshot(inventory),
    fingerprint: evaluated.adoption.fingerprint,
    adoptedAt: now.toISOString(),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return evaluateAdoption(inventory, record);
}
