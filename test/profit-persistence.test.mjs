import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { calculateProductProfit } from '../lib/profit-model.mjs';
import { applySupplierProfitResult } from '../lib/supplier-profit-result.mjs';
import { SUPPLIER_COST_RULE_VERSION } from '../lib/1688-supplier-policy.mjs';
import { SupplierPipelineRunner } from '../lib/supplier-pipeline-runner.mjs';

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'scout-profit-persistence-'));
const previousDataDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(temporaryRoot, 'module-default');
let PersistenceStore;
try {
  ({ PersistenceStore } = await import('../lib/persistence-store.mjs'));
} finally {
  if (previousDataDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
  else process.env.SCOUT_DATA_DIR = previousDataDirectory;
}
after(async () => {
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith('scout-profit-persistence-'));
  await rm(temporaryRoot, { recursive: true, force: true });
});

const ASIN = 'B000000001';
const NOW = '2026-09-24T03:00:00.000Z';
const product = (overrides = {}) => ({
  id: `CA:${ASIN}`, asin: ASIN, sourceAsin: ASIN, marketplace: 'CA', currency: 'CAD',
  analysisSourceMode: 'amazon_only', name: 'Reusable bag, 2 Pack', englishName: 'Reusable bag, 2 Pack',
  currentPrice: 20, currentPriceStatus: 'verified', detailStatus: 'success', detailParserVersion: 5,
  productWeight: 0.1, billingWeight: 0.1, rating: 4.2, reviews: 18, sales30: 50,
  sales30Evidence: { source: 'amazon_product_page', period: 'past_month', kind: 'lower_bound',
    value: 50, rawText: '50+ bought in past month', asin: ASIN },
  imageUrl: 'https://m.media-amazon.com/images/I/synthetic.jpg', sellerId: 'EXAMPLESELLER',
  purchaseUnitCostCny: 3, purchaseCost: 6, supplierAverageCny: 3,
  suppliers: [{ unitPriceCny: 3 }], supplierSearchStatus: 'complete',
  manualSalePrice: false, manualFbaFee: false, manualPurchaseCost: false,
  fulfillmentMode: 'FBA', fieldSources: { currentPrice: 'amazon_product_page' }, reviewStatus: 'pending',
  ...overrides,
});
const snapshot = (runId, products = [product()], state = {}) => ({
  runState: { id: runId, marketplace: 'CA', currency: 'CAD', amazonDomain: 'www.amazon.ca', exchangeRate: 5.2, mode: 'live', analysisSourceMode: 'amazon_only', errors: [], ...state },
  products,
});
const rawAmazon = (overrides = {}) => ({
  asin: ASIN, sourceAsin: ASIN, marketplace: 'CA', title: 'Reusable bag, 2 Pack',
  currentPrice: 9.99, priceEvidence: { asin: ASIN, currency: 'CAD', source: 'visible_main_price', rawText: '$9.99' },
  productWeightKg: 0.3, fbaPackageWeightKg: 0.4, rating: 4.2, reviewCount: 18, sales30: 50,
  imageUrl: 'https://m.media-amazon.com/images/I/synthetic.jpg', detailStatus: 'success', detailParserVersion: 5,
  detailRetryable: false, detailError: null, detailErrorCode: null, collectedAt: NOW,
  fieldSources: { currentPrice: 'amazon_product_page', productWeightKg: 'amazon_product_page' },
  fieldAudit: { currentPrice: { status: 'verified' } }, collectionQuality: { complete: true }, ...overrides,
});
const finalizedQuote = (overrides = {}) => ({
  status: 'complete', ruleVersion: SUPPLIER_COST_RULE_VERSION, averageCostCny: 7,
  procurementTaskId: 'task_synthetic_001', searchedAt: NOW, selectionMode: 'image_similarity_top6', costConfidence: 'high',
  quotes: Array.from({ length: 6 }, (_, index) => ({ supplierId: `supplier-${index}`, unitPriceCny: 7, imageSimilarityScore: 0.95 })),
  ...overrides,
});
async function createStore(name) {
  const store = new PersistenceStore({ directory: path.join(temporaryRoot, name) });
  await store.ready();
  return store;
}
async function diskSnapshot(store, runId) {
  return JSON.parse(await readFile(store.runPath(runId), 'utf8')).snapshot;
}
const applyQuote = (store, runId, result = finalizedQuote()) => store.updateSupplierSnapshot(runId, current => {
  current.products = current.products.map(item => applySupplierProfitResult(item, result, current));
});
const collect = (store, runId, revision = 1, raw = rawAmazon()) => store.updateAmazonCollection(runId, () => ({
  job: { runId, status: 'completed', revision, completedAt: NOW }, items: { [ASIN]: raw },
}), { activate: true });

function assertFormula(item) {
  const purchaseCostAssumedZero = item.purchaseCost === null || item.purchaseCost === undefined || item.purchaseCost === '';
  const expected = calculateProductProfit({
    ...item.profitInputs, salePrice: item.salePrice, purchaseCostCny: purchaseCostAssumedZero ? 0 : item.purchaseCost,
    fulfillmentMode: item.fulfillmentMode, fulfillmentFee: item.fulfillmentMode === 'FBM' ? item.fbmFee : item.fbaFee,
    actualWeightKg: item.billingWeight ?? item.profitInputs.actualWeightKg,
    dimensionsCm: item.profitInputs.dimensionsCm,
  });
  assert.ok(expected, 'Complete persisted inputs must be calculable by the existing profit formula.');
  for (const [field, value] of Object.entries(expected)) assert.deepEqual(item.profitCalculation[field], value, field);
  assert.equal(item.margin, expected.margin);
  assert.equal(item.profitValue, expected.profit);
  assert.equal(item.totalCost, expected.totalCost);
  assert.equal(item.profitCalculation.purchaseCostAssumedZero, purchaseCostAssumedZero);
  assert.deepEqual(item.profitPendingReasons, []);
}

test('saving a snapshot without a collection persists calculated profit before any read projection', async () => {
  const store = await createStore('no-collection');
  const input = snapshot('no-collection');
  const before = structuredClone(input);
  await store.saveSnapshot(input);
  const saved = (await diskSnapshot(store, input.runState.id)).products[0];
  assert.equal(saved.salePrice, 20);
  assert.equal(saved.purchaseCost, 6);
  assert.equal(saved.pieceCount, 2);
  assertFormula(saved);
  assert.deepEqual(input, before);
  assert.deepEqual((await store.getAmazonCollection(input.runState.id)).items, {});
});

test('a profit estimate is persisted and restored without inventing a procurement cost or completing the product', async () => {
  const store = await createStore('estimated-profit');
  const runId = 'estimated-profit';
  await store.saveSnapshot(snapshot(runId, [product({
    purchaseCost: null, purchaseUnitCostCny: null, supplierAverageCny: null,
    suppliers: [], supplierSearchStatus: 'not_started',
  })]));
  const saved = (await diskSnapshot(store, runId)).products[0];
  assert.equal(saved.purchaseCost, null);
  assert.equal(saved.purchaseUnitCostCny, null);
  assert.equal(saved.supplierAverageCny, null);
  assert.equal(saved.complete, false);
  assert.ok(saved.missing.includes('采购成本'));
  assert.equal(saved.profitCalculation.purchaseCostAssumedZero, true);
  assertFormula(saved);
  const restarted = new PersistenceStore({ directory: store.directory });
  await restarted.ready();
  assert.deepEqual((await restarted.getRunSnapshot(runId)).products[0], saved);
});

test('Amazon weight and a changed price each commit newly computed profit with the source result', async () => {
  const store = await createStore('amazon-arrivals');
  const runId = 'amazon-arrivals';
  await store.saveSnapshot(snapshot(runId, [product({ productWeight: null, billingWeight: null })]));
  // A successfully collected page without weight permits the CA minimum fee, but not complete profit.
  const weightless = (await diskSnapshot(store, runId)).products[0];
  assert.equal(weightless.margin, null);
  assert.equal(weightless.profitCalculation, null);
  assert.deepEqual(weightless.profitPendingReasons, ['商品重量']);
  assert.equal(weightless.fbaFee, 4.73 * 1.035);
  assert.equal(weightless.fbaFeeSource, 'missing_weight_minimum_fba_estimate');
  assert.equal(weightless.fbaEstimate.assumption, 'missing_weight_minimum_fba_estimate');
  assert.equal(weightless.fbaEstimate.actualWeightKg, null);
  assert.equal(weightless.fbaEstimate.billableWeightG, null);
  assert.equal(weightless.productWeight, null);
  assert.equal(weightless.billingWeight, null);
  assert.equal(weightless.profitInputs.actualWeightKg, null);
  await collect(store, runId);
  const weighted = (await diskSnapshot(store, runId)).products[0];
  assert.equal(weighted.productWeight, 0.3);
  assert.equal(weighted.salePrice, 9.99);
  assert.equal(weighted.fbaFee, (5.31 - 0.8) * 1.035);
  assert.equal(weighted.fbaFeeSource, 'ca_peak_envelope_price_rate');
  assertFormula(weighted);
  await collect(store, runId, 2, rawAmazon({ currentPrice: 30 }));
  const repriced = (await diskSnapshot(store, runId)).products[0];
  assert.equal(repriced.salePrice, 30);
  assert.equal(repriced.fbaFee, 5.31 * 1.035);
  assert.notEqual(repriced.margin, weighted.margin);
  assertFormula(repriced);
  assert.deepEqual((await store.getRunSnapshot(runId)).products[0], repriced);
});

for (const status of ['complete', 'fallback_estimate']) {
  test(`${status} finalized quotes commit unit cost, piece-adjusted total and readable profit together`, async () => {
    const store = await createStore(`quote-${status}`);
    const runId = `quote-${status}`;
    await store.saveSnapshot(snapshot(runId, [product({ purchaseCost: null, purchaseUnitCostCny: null, supplierAverageCny: null, suppliers: [] })], {
      errors: [{ stage: '1688_image_search', productId: `CA:${ASIN}` }],
    }));
    const estimated = (await diskSnapshot(store, runId)).products[0];
    assert.equal(estimated.purchaseCost, null);
    assert.equal(estimated.complete, false);
    assert.equal(estimated.profitCalculation.purchaseCostAssumedZero, true);
    assertFormula(estimated);
    const quote = finalizedQuote({ status });
    const original = structuredClone(quote);
    await applyQuote(store, runId, quote);
    const persisted = await diskSnapshot(store, runId);
    const item = persisted.products[0];
    assert.equal(item.purchaseUnitCostCny, 7);
    assert.equal(item.purchaseCost, 14);
    assert.equal(item.profitCalculation.purchaseCostAssumedZero, false);
    assert.ok(item.margin < estimated.margin);
    assert.ok(item.totalCost > estimated.totalCost);
    assert.equal(item.supplierSearchStatus, status);
    assert.equal(item.supplierProcurementTaskId, quote.procurementTaskId);
    assert.deepEqual(item.suppliers, quote.quotes);
    assert.equal(persisted.runState.errors[0].recovered, true);
    assertFormula(item);
    assert.deepEqual((await store.getRunSnapshot(runId)).products[0], item);
    assert.deepEqual(quote, original);
  });
}

test('source-update notifications expose already committed run and index data without network calls', async t => {
  const store = await createStore('commit-notifications');
  const runId = 'commit-notifications';
  await store.saveSnapshot(snapshot(runId));
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('Persistence must never fetch.'); });
  const events = [];
  const unsubscribe = store.onSnapshotUpdated(event => {
    // Synchronous reads inside the callback establish commit ordering; asynchronous
    // reads after awaiting the update could hide an early notification bug.
    events.push({ event, document: JSON.parse(readFileSync(store.runPath(runId), 'utf8')), index: JSON.parse(readFileSync(store.indexPath, 'utf8')) });
  });
  await collect(store, runId);
  await applyQuote(store, runId);
  assert.equal(events.length, 2);
  assert.equal(events[0].document.snapshot.products[0].salePrice, 9.99);
  assert.equal(events[1].document.snapshot.products[0].purchaseCost, 14);
  for (const entry of events) {
    assert.deepEqual(entry.event, { runId });
    assertFormula(entry.document.snapshot.products[0]);
    assert.equal(entry.index.runs.find(run => run.id === runId).updatedAt, entry.document.updatedAt);
  }
  assert.equal(fetchSpy.mock.callCount(), 0);
  unsubscribe();
  await applyQuote(store, runId, finalizedQuote({ averageCostCny: 8 }));
  assert.equal(events.length, 2);
});

test('Amazon and supplier updates preserve manual price, title, weight, piece count, fees and rate inputs', async () => {
  const store = await createStore('manual-fields');
  const runId = 'manual-fields';
  await store.saveSnapshot(snapshot(runId, [product({
    currentPrice: 21, manualAmazonFields: { currentPrice: true, title: true }, name: 'Manual title', englishName: 'Manual title',
    manualSalePrice: true, salePrice: 17, manualWeight: true, productWeight: 0.2, billingWeight: 0.2,
    pieceCount: 3, pieceCountSource: 'manual', manualFbaFee: true, fbaFee: 2.2,
    profitInputs: { exchangeRate: 5.4, commissionRate: 9, actualWeightKg: 0.2, weightSource: 'product_manual', airFreightRateCnyPerKg: 52, airFreightRateSource: 'product_manual' },
  })]));
  await collect(store, runId);
  await applyQuote(store, runId);
  const item = (await diskSnapshot(store, runId)).products[0];
  assert.equal(item.currentPrice, 21);
  assert.equal(item.name, 'Manual title');
  assert.equal(item.englishName, 'Manual title');
  assert.equal(item.salePrice, 17);
  assert.equal(item.productWeight, 0.2);
  assert.equal(item.billingWeight, 0.2);
  assert.equal(item.pieceCount, 3);
  assert.equal(item.purchaseCost, 21);
  assert.equal(item.fbaFee, 2.2);
  assert.equal(item.profitInputs.exchangeRate, 5.4);
  assert.equal(item.profitInputs.commissionRate, 9);
  assert.equal(item.profitInputs.airFreightRateCnyPerKg, 52);
  assertFormula(item);
});

for (const [label, marker] of [
  ['explicit', { manualPurchaseCost: true }], ['legacy-cost-source', { costSource: 'manual' }], ['legacy-supplier-source', { supplierSource: 'manual_legacy' }],
]) {
  test(`${label} manual procurement costs survive successful and unsuccessful supplier results`, async () => {
    const store = await createStore(label);
    await store.saveSnapshot(snapshot(label, [product({ ...marker, purchaseCost: 0, purchaseUnitCostCny: 0, supplierAverageCny: 5 })]));
    const before = (await diskSnapshot(store, label)).products[0];
    assert.equal(before.purchaseCost, 0);
    await applyQuote(store, label);
    assert.deepEqual((await diskSnapshot(store, label)).products[0], before);
    await applyQuote(store, label, finalizedQuote({ status: 'insufficient', averageCostCny: null, quotes: [] }));
    assert.deepEqual((await diskSnapshot(store, label)).products[0], before);
  });
}

test('procurement-owned handed-off product data and its frozen calculation survive every source update', async () => {
  const store = await createStore('handoff');
  const frozen = product({ analysisHandoff: { owner: 'procurement', revision: 3 }, margin: 42, profitValue: 7, totalCost: 5, profitCalculation: { profit: 7, calculatedAt: NOW } });
  await store.saveSnapshot(snapshot('handoff', [frozen]));
  await collect(store, 'handoff');
  await applyQuote(store, 'handoff');
  assert.deepEqual((await diskSnapshot(store, 'handoff')).products[0], frozen);
  assert.deepEqual((await store.getRunSnapshot('handoff')).products[0], frozen);
});

for (const order of ['amazon-first', 'supplier-first']) {
  test(`concurrent ${order} transactions retain both new Amazon inputs and supplier costs`, async () => {
    const store = await createStore(order);
    await store.saveSnapshot(snapshot(order, [product({ purchaseCost: null, purchaseUnitCostCny: null, supplierAverageCny: null, suppliers: [] })]));
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = order === 'amazon-first'
      ? store.updateAmazonCollection(order, async () => { entered(); await gate; return { job: { revision: 1, status: 'completed' }, items: { [ASIN]: rawAmazon() } }; })
      : store.updateSupplierSnapshot(order, async current => { entered(); await gate; current.products[0] = applySupplierProfitResult(current.products[0], finalizedQuote(), current); });
    await started;
    const second = order === 'amazon-first' ? applyQuote(store, order) : collect(store, order);
    release();
    await Promise.all([first, second]);
    const item = (await diskSnapshot(store, order)).products[0];
    assert.equal(item.currentPrice, 9.99);
    assert.equal(item.productWeight, 0.3);
    assert.equal(item.purchaseCost, 14);
    assert.equal(item.supplierProcurementTaskId, 'task_synthetic_001');
    assertFormula(item);
  });
}

for (const state of ['paused', 'running']) {
  test(`the active supplier pointer survives restart ahead of the latest viewed run (${state})`, async () => {
    const store = await createStore(`restart-${state}`);
    const runId = `active-${state}`;
    await store.saveSnapshot(snapshot(runId, [product({ supplierSearchStatus: 'not_started', suppliers: [], purchaseCost: null, purchaseUnitCostCny: null, supplierAverageCny: null })], {
      supplier1688Pipeline: { owner: 'server', enabled: state !== 'paused', status: state, revision: 3, productIds: [`CA:${ASIN}`], activeProductId: state === 'running' ? `CA:${ASIN}` : null, tasks: { [`CA:${ASIN}`]: { status: state === 'running' ? 'running' : 'pending' } }, causeCode: state === 'paused' ? 'USER_PAUSED' : null },
    }));
    await store.setActiveSupplierRunId(runId);
    await store.saveSnapshot(snapshot(`viewed-${state}`));
    assert.equal(JSON.parse(await readFile(store.indexPath, 'utf8')).latestRunId, `viewed-${state}`);
    const restarted = new PersistenceStore({ directory: store.directory });
    await restarted.ready();
    assert.equal(await restarted.getActiveSupplierRunId(), runId);
    assert.equal((await restarted.getOverview()).latestRunId, runId);
    let networkWork = 0;
    const runner = new SupplierPipelineRunner({
      store: { getActiveRunId: () => restarted.getActiveSupplierRunId(), setActiveRunId: id => restarted.setActiveSupplierRunId(id), readSnapshot: id => restarted.getRunSnapshot(id), updateSnapshot: (id, updater) => restarted.updateSupplierSnapshot(id, updater) },
      search: () => { networkWork += 1; throw new Error('No search expected during restoration.'); },
      getRuntime: () => { networkWork += 1; throw new Error('No runtime lookup expected during restoration.'); },
      applyResult: applySupplierProfitResult,
    });
    try {
      const restored = await runner.initialize({ timer: false });
      assert.equal(restored.runId, runId);
      assert.equal(restored.status, state === 'running' ? 'queued' : 'paused');
      if (state === 'paused') {
        assert.equal(restored.enabled, false);
        assert.equal(restored.causeCode, 'USER_PAUSED');
        await runner.tick();
      } else {
        assert.equal(restored.restartCount, 1);
        assert.equal(restored.tasks[`CA:${ASIN}`].status, 'pending');
        assert.equal(restored.activeProductId, null);
      }
      assert.equal(networkWork, 0);
    } finally {
      await runner.close();
    }
  });
}

test('stale browser snapshots and old collection revisions cannot overwrite newer persisted profit', async () => {
  const store = await createStore('stale-collection');
  const runId = 'stale-collection';
  await store.saveSnapshot(snapshot(runId));
  const stale = await store.getRunSnapshot(runId);
  await collect(store, runId, 2);
  const before = await readFile(store.runPath(runId), 'utf8');
  await assert.rejects(store.saveSnapshot(stale), { code: 'STALE_COLLECTION_SNAPSHOT', status: 409 });
  await assert.rejects(collect(store, runId, 1, rawAmazon({ currentPrice: 279 })), { code: 'STALE_COLLECTION_UPDATE', status: 409 });
  assert.equal(await readFile(store.runPath(runId), 'utf8'), before);
  assertFormula((await diskSnapshot(store, runId)).products[0]);
});
