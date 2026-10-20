import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const directory = await mkdtemp(path.join(os.tmpdir(), 'scout-item-weight-normalization-'));
const previous = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = directory;
const { analyzeAmazonDiscoveredAsins } = await import('../server.mjs');
const { persistenceStore } = await import('../lib/persistence-store.mjs');
await persistenceStore.ready();
if (previous === undefined) delete process.env.SCOUT_DATA_DIR;
else process.env.SCOUT_DATA_DIR = previous;
after(async () => {
  await persistenceStore.writeQueue;
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('scout-item-weight-normalization-'));
  await rm(directory, { recursive: true, force: true });
});

const asin = 'B08YWZC4C6';
async function normalize(detail) {
  const result = await analyzeAmazonDiscoveredAsins(
    [{ asins: [asin], sourceStore: { storeIndex: 0 }, visit: { complete: true } }],
    { marketplace: 'AU', inputMode: 'asins' }, '2026-10-14T00:00:00Z', undefined,
    { detailLoader: async () => ({ asin, title: 'Item Weight normalization fixture', ...detail }) },
  );
  assert.equal(result.items.length, 1);
  return result.items[0];
}

test('server normalization never turns Package Weight into product weight or evidence', async () => {
  const packageEvidence = { label: 'package weight', rawText: '220 Grams', value: 0.22, kind: 'package' };
  const item = await normalize({ productWeightKg: null, packageWeightKg: 0.22,
    packageWeightEvidence: packageEvidence, fieldSources: { packageWeightKg: 'amazon_product_page' },
    productInformation: { weightSelection: { policy: 'item_weight_only', selected: null, alternatives: [] } } });
  assert.equal(item.productWeightKg, null);
  assert.equal(item.productWeightEvidence, null);
  assert.equal(item.fieldSources.productWeightKg, undefined);
  assert.equal(item.fbaPackageWeightKg, 0.22);
  assert.deepEqual(item.packageWeightEvidence, packageEvidence);
  assert.equal(item.weightSelection.policy, 'item_weight_only');
  assert.notEqual(item.collectionQuality.fields.weight.status, 'verified');
  assert.ok(item.missingFields.includes('weight'));
});

test('server keeps selected Item Weight and diagnostic ASIN observations separate from task identity', async () => {
  const evidence = { asin, label: 'item weight', rawText: '170 Grams', value: 0.17, kind: 'product' };
  const selection = { policy: 'item_weight_only', selected: evidence, alternatives: [] };
  const diagnostics = { sourceAsin: asin, pageAsin: 'B000000002', policy: 'observe_without_rejection' };
  const item = await normalize({ productWeightKg: 0.17, packageWeightKg: 0.22,
    productWeightEvidence: evidence, fieldSources: { productWeightKg: 'amazon_product_page' },
    productInformation: { weightSelection: selection, identityDiagnostics: diagnostics },
    amazonFirstAvailableDateStatus: 'not_provided' });
  assert.equal(item.asin, asin);
  assert.equal(item.sourceAsin, asin);
  assert.equal(item.productWeightKg, 0.17);
  assert.deepEqual(item.productWeightEvidence, evidence);
  assert.deepEqual(item.weightSelection, selection);
  assert.deepEqual(item.productInformation.identityDiagnostics, diagnostics);
  assert.equal(item.amazonFirstAvailableDateStatus, 'not_provided');
  assert.equal(item.collectionQuality.fields.weight.status, 'verified');
});
