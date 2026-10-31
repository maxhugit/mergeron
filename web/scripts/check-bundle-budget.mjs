import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const assetsDirectory = path.resolve(webRoot, '..', 'public', 'assets');

const budgets = {
  maximumJavaScriptAssetBytes: 1_100_000,
  mainEntryAssetBytes: 350_000,
  totalJavaScriptBytes: 18_000_000,
  // The shared catalog includes the platform guide, source picker and agent
  // controls. Persistent question replies add reviewed French/English labels;
  // the largest production catalog is now 184,424 bytes. Keep a narrow ceiling
  // around that content while preserving regression detection.
  commonCatalogAssetBytes: 185_000,
};

const entries = await readdir(assetsDirectory, { withFileTypes: true }).catch(
  () => null,
);

if (!entries) {
  console.error('Frontend assets are missing. Run the frontend build first.');
  process.exit(1);
}

const assets = await Promise.all(
  entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map(async (entry) => ({
      name: entry.name,
      size: (await stat(path.join(assetsDirectory, entry.name))).size,
    })),
);

assets.sort((left, right) => right.size - left.size);
const totalJavaScriptBytes = assets.reduce(
  (total, asset) => total + asset.size,
  0,
);
const largestAsset = assets[0];
const mainEntryAsset = assets.find((asset) => asset.name.startsWith('index-'));
const commonCatalogAsset = assets.find((asset) =>
  asset.name.startsWith('common-'),
);
const failures = [];

if (!largestAsset) {
  failures.push('No JavaScript assets were produced.');
} else if (largestAsset.size > budgets.maximumJavaScriptAssetBytes) {
  failures.push(
    `${largestAsset.name} is ${largestAsset.size} bytes; budget is ${budgets.maximumJavaScriptAssetBytes}.`,
  );
}

if (totalJavaScriptBytes > budgets.totalJavaScriptBytes) {
  failures.push(
    `JavaScript assets total ${totalJavaScriptBytes} bytes; budget is ${budgets.totalJavaScriptBytes}.`,
  );
}

if (!mainEntryAsset) {
  failures.push('The main JavaScript entry was not produced.');
} else if (mainEntryAsset.size > budgets.mainEntryAssetBytes) {
  failures.push(
    `${mainEntryAsset.name} is ${mainEntryAsset.size} bytes; main entry budget is ${budgets.mainEntryAssetBytes}.`,
  );
}

if (
  commonCatalogAsset &&
  commonCatalogAsset.size > budgets.commonCatalogAssetBytes
) {
  failures.push(
    `${commonCatalogAsset.name} is ${commonCatalogAsset.size} bytes; budget is ${budgets.commonCatalogAssetBytes}.`,
  );
}

console.log('Largest JavaScript assets:');
for (const asset of assets.slice(0, 5)) {
  console.log(`- ${asset.name}: ${asset.size} bytes`);
}
console.log(`Total JavaScript: ${totalJavaScriptBytes} bytes`);
if (mainEntryAsset) {
  console.log(`Main JavaScript entry: ${mainEntryAsset.size} bytes`);
}

if (failures.length > 0) {
  console.error('\nBundle budget exceeded:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Frontend bundle budgets are respected.');
