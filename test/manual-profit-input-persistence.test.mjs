import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recomputeProductProfit } from '../lib/product-profit-state.mjs';
import { mergeAmazonCollectionProduct } from '../lib/amazon-collection-merge.mjs';
import { resolveAnalysisProfitInputs } from '../lib/analysis-handoff.mjs';
import { applySupplierProfitResult } from '../lib/supplier-profit-result.mjs';
import { SUPPLIER_COST_RULE_VERSION } from '../lib/1688-supplier-policy.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'scout-manual-profit-'));
const previousDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(root, 'module-default');
let PersistenceStore;
try { ({ PersistenceStore } = await import('../lib/persistence-store.mjs')); }
finally {
  if (previousDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
  else process.env.SCOUT_DATA_DIR = previousDirectory;
}
after(async () => {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('scout-manual-profit-'));
  await rm(resolved, { recursive: true, force: true });
});

const ASIN = 'B000000001';
const NOW = '2026-10-10T01:00:00.000Z';
const product = (extra = {}) => ({
  id: 'AU:' + ASIN, asin: ASIN, sourceAsin: ASIN, marketplace: 'AU', currency: 'AUD',
  analysisSourceMode: 'amazon_only', name: 'Synthetic set', englishName: 'Synthetic set',
  detailStatus: 'success', currentPrice: 20, productWeight: 0.7, billingWeight: 0.7,
  purchaseUnitCostCny: 3, purchaseCost: 3, supplierAverageCny: 3,
  suppliers: [{ offerId: 'original-quote', unitPriceCny: 3 }],
  fieldSources: { currentPrice: 'amazon_product_page' }, ...extra,
});
const snapshot = (id, item) => ({ runState: { id, marketplace: 'AU', errors: [] }, products: [item] });
const rawAmazon = (extra = {}) => ({
  asin: ASIN, marketplace: 'AU', title: 'Updated title, 12 Pack', detailStatus: 'success',
  currentPrice: 40, productWeightKg: 0.9, fbaPackageWeightKg: 1, collectedAt: NOW,
  fieldSources: { currentPrice: 'amazon_product_page', productWeightKg: 'amazon_product_page' }, ...extra,
});
const quoteResult = {
  ruleVersion: SUPPLIER_COST_RULE_VERSION, status: 'complete', averageCostCny: 9,
  quotes: [{ offerId: 'later-quote', unitPriceCny: 9 }], searchedAt: NOW,
};
async function createStore(id, item) {
  const store = new PersistenceStore({ directory: path.join(root, id) });
  await store.ready();
  await store.saveSnapshot(snapshot(id, item));
  return store;
}
async function reloadProduct(store, id) {
  const restarted = new PersistenceStore({ directory: store.directory });
  await restarted.ready();
  const item = (await restarted.getRunSnapshot(id)).products[0];
  const onDisk = JSON.parse(await readFile(restarted.runPath(id), 'utf8')).snapshot.products[0];
  assert.deepEqual(item, onDisk);
  return item;
}
const collect = (store, id) => store.updateAmazonCollection(id, () => ({
  job: { runId: id, status: 'completed', revision: 1, completedAt: NOW }, items: { [ASIN]: rawAmazon() },
}), { activate: true });

const weightCases = [
  ['nested-english', { billingWeight: 0.7, profitInputs: { actualWeightKg: 0.2, weightSource: 'product_manual' } }],
  ['outer-chinese', { billingWeight: 0.2, weightSource: '产品手工覆盖', profitInputs: { actualWeightKg: 0.7 } }],
  ['outer-english', { billingWeight: 0.2, weightSource: 'manual' }],
  ['billing-flag', { billingWeight: 0.2, manualBillingWeight: true, profitInputs: { actualWeightKg: 0.7 } }],
  ['generic-flag', { billingWeight: 0.2, manualWeight: true }],
  ['product-flag', { productWeight: 0.2, manualProductWeight: true }],
  ['package-flag', { fbaWeight: 0.2, manualFbaWeight: true }],
  ['billing-field', { billingWeight: 0.2, fieldSources: { billingWeight: 'manual' } }],
  ['product-field', { productWeight: 0.2, fieldSources: { productWeightKg: 'manual' } }],
  ['product-field-english', { productWeight: 0.2, fieldSources: { productWeightKg: 'product_manual' } }],
  ['actual-field', { actualWeightKg: 0.2, fieldSources: { actualWeightKg: 'manual' } }],
  ['generic-field', { weightKg: 0.2, fieldSources: { weightKg: 'manual' } }],
  ['package-field', { fbaWeight: 0.2, manualAmazonFields: { fbaPackageWeightKg: true } }],
];
for (const [name, overrides] of weightCases) {
  test('manual weight ' + name + ' survives recomputation, collection, persisted restart and handoff', async () => {
    const input = product(overrides);
    const before = structuredClone(input);
    const first = recomputeProductProfit(input);
    const repeated = recomputeProductProfit(first);
    const merged = recomputeProductProfit(mergeAmazonCollectionProduct(input, rawAmazon()));
    const store = await createStore('weight-' + name, input);
    await collect(store, 'weight-' + name);
    const restored = await reloadProduct(store, 'weight-' + name);
    for (const item of [first, repeated, merged, restored]) {
      assert.equal(item.billingWeight, 0.2);
      assert.equal(item.profitInputs.actualWeightKg, 0.2);
      assert.equal(item.profitCalculation.domesticFreightWeightKg, 0.2);
      assert.equal(item.fbaFee, 5.26);
      assert.equal(resolveAnalysisProfitInputs(item).actualWeightKg, 0.2);
      assert.equal(item.productWeight, input.productWeight);
    }
    assert.equal(resolveAnalysisProfitInputs(input).actualWeightKg, 0.2);
    assert.deepEqual(input, before);
  });
}

test('general manual-profit marker alone does not freeze an automatic Amazon weight', () => {
  const item = product({ manualProfitInputs: true, billingWeight: 0.2,
    profitInputs: { actualWeightKg: 0.2, weightSource: 'Amazon 商品重量', marketingRate: 7 } });
  const updated = recomputeProductProfit(mergeAmazonCollectionProduct(item, rawAmazon()));
  assert.equal(updated.billingWeight, 0.9);
  assert.equal(updated.profitInputs.actualWeightKg, 0.9);
  assert.equal(updated.profitInputs.marketingRate, 7);
});

for (const [name, marker] of [
  ['flag', { manualFbaFee: true }],
  ['source', { fbaFeeSource: 'manual' }],
  ['localized-source', { fbaFeeSource: '人工填写' }],
  ['field-source', { fieldSources: { fbaFee: 'manual' } }],
  ['field-flag', { manualAmazonFields: { fbaFee: true } }],
]) {
  test('manual FBA fee ' + name + ' including zero survives changed price and weight', async () => {
    for (const fee of [0, 9.87]) {
      const id = 'fee-' + name + '-' + fee;
      const input = product({ ...marker, fbaFee: fee, fulfillmentMode: 'FBA' });
      assert.equal(mergeAmazonCollectionProduct(input, rawAmazon()).fbaFee, fee);
      const store = await createStore(id, input);
      await collect(store, id);
      const item = await reloadProduct(store, id);
      assert.equal(item.productWeight, 0.9);
      assert.equal(item.currentPrice, 40);
      assert.equal(item.fbaFee, fee);
      assert.equal(item.manualFbaFee, true);
      assert.equal(item.profitCalculation.fulfillmentFee, fee);
      assert.equal(recomputeProductProfit(item).fbaFee, fee);
    }
  });
}

test('legacy manual FBM fee provenance remains manual and independent of FBA', () => {
  const item = recomputeProductProfit(product({ fulfillmentMode: 'FBM', fbmFee: 0, fbmFeeSource: 'manual' }));
  assert.equal(item.manualFbmFee, true);
  assert.equal(item.fbmFee, 0);
  assert.equal(item.profitCalculation.fulfillmentFee, 0);
});

test('each of the six manual inputs can persist while other profit inputs are missing', async () => {
  const cases = [
    ['sale', { salePrice: 31.25, manualSalePrice: true }, { salePrice: 31.25 }],
    ['unit-cost', { purchaseUnitCostCny: 1.234567, manualPurchaseCost: true }, { purchaseUnitCostCny: 1.234567, purchaseCost: 1.23 }],
    ['piece-count', { pieceCount: 7, pieceCountSource: 'manual' }, { pieceCount: 7 }],
    ['set-cost', { purchaseCost: 10, purchaseUnitCostCny: 10 / 3, manualPurchaseCost: true, pieceCount: 3, pieceCountSource: 'manual' }, { purchaseCost: 10, purchaseUnitCostCny: 10 / 3, pieceCount: 3 }],
    ['fee', { fbaFee: 2.34, manualFbaFee: true }, { fbaFee: 2.34 }],
    ['weight', { billingWeight: 0.234, manualBillingWeight: true }, { billingWeight: 0.234 }],
  ];
  for (const [name, edit, expected] of cases) {
    const id = 'incomplete-' + name;
    const input = product({ currentPrice: null, productWeight: null, billingWeight: null,
      purchaseUnitCostCny: null, purchaseCost: null, supplierAverageCny: null, suppliers: [], ...edit });
    const store = await createStore(id, input);
    const restored = await reloadProduct(store, id);
    for (const [field, value] of Object.entries(expected)) assert.equal(restored[field], value, name + '.' + field);
    assert.equal(restored.complete, false);
    assert.equal(restored.profitCalculation, null);
    assert.equal(restored.reviewStatus, undefined);
  }
});

test('all six manual inputs survive subsequent Amazon changes and supplier quote updates together', async () => {
  const id = 'all-six';
  const input = product({ salePrice: 31.25, manualSalePrice: true,
    purchaseUnitCostCny: 10 / 3, purchaseCost: 10, manualPurchaseCost: true, costSource: 'manual',
    pieceCount: 3, pieceCountSource: 'manual', fbaFee: 2.34, manualFbaFee: true,
    billingWeight: 0.2, manualBillingWeight: true });
  const store = await createStore(id, input);
  await collect(store, id);
  await store.updateSupplierSnapshot(id, current => {
    current.products = current.products.map(item => applySupplierProfitResult(item, quoteResult, current));
  });
  const restored = await reloadProduct(store, id);
  for (const field of ['salePrice', 'purchaseUnitCostCny', 'purchaseCost', 'pieceCount', 'fbaFee', 'billingWeight']) {
    assert.equal(restored[field], input[field], field);
  }
  assert.equal(restored.currentPrice, 40);
  assert.equal(restored.supplierAverageCny, input.supplierAverageCny);
  assert.deepEqual(restored.suppliers, input.suppliers);
  assert.equal(restored.profitCalculation.purchaseCostCny, 10);
  assert.equal(restored.profitCalculation.domesticFreightWeightKg, 0.2);
});

test('procurement-owned records remain unchanged through protected recompute and background paths', async () => {
  const id = 'frozen';
  const frozen = product({ analysisHandoff: { owner: 'procurement', revision: 3 },
    fbaFee: 9.87, fbaFeeSource: 'manual', billingWeight: 0.2, manualBillingWeight: true,
    profitCalculation: { profit: 99, calculatedAt: NOW } });
  const before = structuredClone(frozen);
  assert.deepEqual(recomputeProductProfit(frozen), before);
  assert.deepEqual(mergeAmazonCollectionProduct(frozen, rawAmazon()), before);
  assert.deepEqual(applySupplierProfitResult(frozen, quoteResult, snapshot(id, frozen)), before);
  const store = await createStore(id, frozen);
  await collect(store, id);
  assert.deepEqual(await reloadProduct(store, id), before);
});
