import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { amazonMonthlySalesValue, hasQualifyingAmazonMonthlySales } from '../lib/amazon-sales-policy.mjs';

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'scout-full-collection-scope-'));
const previousDataDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(temporaryRoot, 'module-default');
let deferStoreAfterAmazonPause, discoveryFromAmazonCheckpoint, collectDiscoveredAsinTargets, analyzeAmazonDiscoveredAsins, candidateFilterExclusionReasons;
try {
  ({ deferStoreAfterAmazonPause, discoveryFromAmazonCheckpoint, collectDiscoveredAsinTargets, analyzeAmazonDiscoveredAsins, candidateFilterExclusionReasons } = await import('../server.mjs'));
} finally {
  if (previousDataDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
  else process.env.SCOUT_DATA_DIR = previousDataDirectory;
}
after(async () => {
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith('scout-full-collection-scope-'));
  await rm(temporaryRoot, { recursive: true, force: true });
});

const asins = ['B0A0000001', 'B0A0000002', 'B0A0000003', 'B0A0000004'];
const store = { marketplace: 'AU', sellerId: 'A123456789', storeIndex: 0, asins: [] };
const sourceStore = { sellerId: store.sellerId, storeIndex: 0 };
const card = value => ({ sales30: value, rawText: `${value}+ bought in past month` });
const evidence = (asin, value) => ({ source: 'amazon_product_page', asin, value, rawText: `${value}+ bought in past month`, kind: 'lower_bound', period: 'past_month' });

test('checkpoint recovery retains all observed products and keeps only validated sales evidence', () => {
  const checkpoint = {
    asins: [asins[0]], observedAsins: [...asins, asins[0]], complete: true,
    salesByAsin: { [asins[0]]: card(50), [asins[1]]: card(20), [asins[2]]: { sales30: 100 }, [asins[3]]: { sales30: 200, rawText: '20+ bought in past month' } },
  };
  const before = structuredClone(checkpoint);
  const result = discoveryFromAmazonCheckpoint(store, checkpoint);
  assert.deepEqual(result.asins, asins);
  assert.deepEqual(result.salesByAsin, { [asins[0]]: card(50), [asins[1]]: card(20) });
  assert.equal(result.visit.discoveredAsins, 4);
  assert.deepEqual(checkpoint, before);
  const targets = collectDiscoveredAsinTargets([result]);
  assert.deepEqual(targets.map(target => target.asin), asins);
  assert.deepEqual(targets.map(amazonMonthlySalesValue), [50, 20, null, null]);
  assert.deepEqual(targets.filter(hasQualifyingAmazonMonthlySales).map(target => target.asin), [asins[0]]);
});

test('raw discovery queues no-badge and sub-50 ASINs for details without manufacturing evidence', () => {
  const result = collectDiscoveredAsinTargets([
    { asins, sourceStore, salesByAsin: { [asins[0]]: card(100), [asins[1]]: card(10), [asins[2]]: { sales30: 100 } } },
    { asins: [asins[0]], sourceStore: { sellerId: 'AOTHERSELLER', storeIndex: 1 }, salesByAsin: {} },
  ]);
  assert.equal(result.length, 4);
  assert.equal(result[0].sourceStores.length, 2);
  assert.deepEqual(result.map(amazonMonthlySalesValue), [100, 10, null, null]);
  assert.equal(result[2].sales30Evidence, undefined);
  assert.equal(result[3].sales30Evidence, undefined);
});

test('detail collection visits every discovered ASIN then qualifies only explicit monthly badges', async () => {
  const calls = [];
  const result = await analyzeAmazonDiscoveredAsins([{ asins: asins.slice(0, 3), sourceStore, salesByAsin: {} }],
    { runId: 'full-scope-offline', marketplace: 'AU', detailConcurrency: 1 }, '2026-10-10T01:00:00.000Z', undefined,
    { detailLoader: async asin => {
      calls.push(asin);
      const sales30 = asin === asins[0] ? 100 : asin === asins[1] ? 20 : null;
      return { asin, title: 'Test product', sales30, sales30Evidence: sales30 === null ? null : evidence(asin, sales30) };
    } });
  assert.deepEqual(calls, asins.slice(0, 3));
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map(amazonMonthlySalesValue), [100, 20, null]);
  assert.deepEqual(result.items.map(item => candidateFilterExclusionReasons(item, { minRating: null, minReviews: null })), [[], ['MONTHLY_SALES_BELOW_50'], ['MONTHLY_SALES_EVIDENCE_MISSING']]);
});

test('detail normalization preserves product and package weight provenance separately', async () => {
  const productWeightEvidence = { source: 'amazon_product_page', selector: '#productDetails', label: 'Item Weight', rawText: '60 g', value: 0.06, unit: 'kg', asin: asins[0], kind: 'product' };
  const packageWeightEvidence = { source: 'amazon_product_page', selector: '#productDetails', label: 'Package Weight', rawText: '80 g', value: 0.08, unit: 'kg', asin: asins[0], kind: 'package' };
  const result = await analyzeAmazonDiscoveredAsins([{ asins: [asins[0]], sourceStore, salesByAsin: {} }],
    { runId: 'weight-evidence-offline', marketplace: 'AU' }, '2026-10-10T01:00:00.000Z', undefined,
    { detailLoader: async asin => ({ asin, productWeightKg: 0.06, packageWeightKg: 0.08, productWeightEvidence, packageWeightEvidence }) });
  assert.equal(result.items[0].productWeightKg, 0.06);
  assert.equal(result.items[0].fbaPackageWeightKg, 0.08);
  assert.deepEqual(result.items[0].productWeightEvidence, productWeightEvidence);
  assert.deepEqual(result.items[0].packageWeightEvidence, packageWeightEvidence);
  const packageOnly = await analyzeAmazonDiscoveredAsins([{ asins: [asins[0]], sourceStore, salesByAsin: {} }],
    { runId: 'package-evidence-offline', marketplace: 'AU' }, '2026-10-10T01:00:00.000Z', undefined,
    { detailLoader: async asin => ({ asin, productWeightKg: null, packageWeightKg: 0.08, packageWeightEvidence, fieldSources: { packageWeightKg: 'amazon_product_page' } }) });
  assert.equal(packageOnly.items[0].productWeightKg, null);
  assert.equal(packageOnly.items[0].productWeightEvidence, null);
  assert.equal(packageOnly.items[0].fieldSources.productWeightKg, undefined);
  assert.equal(packageOnly.items[0].fbaPackageWeightKg, 0.08);
  assert.deepEqual(packageOnly.items[0].packageWeightEvidence, packageWeightEvidence);
  assert.ok(packageOnly.items[0].missingFields.includes('weight'));
});


test('access pause preserves full checkpoint scope and valid badge evidence without starting collection', async () => {
  const checkpoint = { asins: [asins[0]], observedAsins: [asins[0], asins[1]], salesByAsin: { [asins[0]]: card(50), [asins[1]]: card(20) }, complete: false };
  let saved;
  const result = await deferStoreAfterAmazonPause(store, checkpoint, { runId: 'pause-offline', marketplace: 'AU' },
    { code: 'AMAZON_ACCESS_CHALLENGE', message: 'Manual verification required' },
    { saveAmazonStoreCheckpoint: async (_runId, value) => { saved = value; } });
  assert.deepEqual(result.asins, asins.slice(0, 2));
  assert.deepEqual(result.salesByAsin, checkpoint.salesByAsin);
  assert.deepEqual(saved.salesByAsin, checkpoint.salesByAsin);
  assert.equal(result.visit.status, 'waiting');
});


test('completed legacy checkpoint restores ASINs recorded only in successful page audits', () => {
  const checkpoint = { complete: true, asins: [asins[0]], salesByAsin: { [asins[0]]: card(100) }, pageAudit: [
    { url: 'https://www.amazon.com.au/s?me=A123456789&page=1', status: 'success', observedAsins: [asins[0], asins[1]] },
    { url: 'https://www.amazon.com.au/s?me=A123456789&page=2', status: 'failed', observedAsins: [asins[3]] },
    { url: 'https://www.amazon.com.au/s?me=A123456789&page=2', status: 'success', observedAsins: [asins[1], asins[2].toLowerCase()] },
  ] };
  const before = structuredClone(checkpoint);
  const result = discoveryFromAmazonCheckpoint(store, checkpoint);
  assert.deepEqual(result.asins, asins.slice(0, 3));
  assert.equal(result.visit.complete, true);
  assert.equal(result.visit.discoveredAsins, 3);
  assert.deepEqual(result.salesByAsin, checkpoint.salesByAsin);
  assert.equal(collectDiscoveredAsinTargets([result]).length, 3);
  assert.deepEqual(checkpoint, before);
});
