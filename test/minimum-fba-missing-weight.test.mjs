import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { estimateMinimumFbaFee, isAmazonWeightUnavailable, PROFIT_FORMULA_VERSION } from '../lib/profit-model.mjs';
import { recomputeProductProfit } from '../lib/product-profit-state.mjs';
import { evaluateAnalysisProduct, resolveAnalysisProfitInputs } from '../lib/analysis-handoff.mjs';

// Exercise actual persistence without importing the store against business data.
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'scout-minimum-envelope-'));
const previousDataDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(temporaryRoot, 'module-default');
let PersistenceStore;
try { ({ PersistenceStore } = await import('../lib/persistence-store.mjs')); }
finally {
  if (previousDataDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
  else process.env.SCOUT_DATA_DIR = previousDataDirectory;
}
after(async () => {
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith('scout-minimum-envelope-'));
  await rm(temporaryRoot, { recursive: true, force: true });
});

const marketCases = [
  ['AU', 4.58, 'AUD', 0.075], ['CA', 4.73 * 1.035, 'CAD', 0.1],
  ...[['US', 'USD'], ['NL', 'EUR'], ['UK', 'GBP'], ['DE', 'EUR'], ['FR', 'EUR'],
    ['IT', 'EUR'], ['ES', 'EUR'], ['PL', 'PLN'], ['MX', 'MXN'], ['BR', 'BRL']]
    .map(([market, currency]) => [market, 3.22, currency, 0.25 / 2.2046226218]),
];

const product = (overrides = {}) => ({
  id: 'AU:B000000001', asin: 'B000000001', sourceAsin: 'B000000001', marketplace: 'AU',
  analysisSourceMode: 'amazon_only', detailStatus: 'success', currentPrice: 25, productWeight: null, billingWeight: null,
  name: 'Synthetic candidate', englishName: 'Synthetic candidate', imageUrl: 'https://example.com/product.jpg',
  sales30: 50, sales30Evidence: { asin: 'B000000001', source: 'amazon_product_page', kind: 'lower_bound',
    period: 'past_month', value: 50, rawText: '50+ bought in past month' },
  productInformation: { version: 1, asin: 'B000000001', status: 'complete', reason: null, rowCount: 1,
    inspection: { version: 3, asin: 'B000000001', status: 'complete', stable: true, rowCount: 1,
      parsedSections: [{ selector: '#productDetails_detailBullets_sections1', rowCount: 1 }],
      sections: [{ selector: '#productDetails_detailBullets_sections1', status: 'complete', rowCount: 1 }] },
    weightStatus: 'not_provided', sections: [{ selector: '#productDetails_detailBullets_sections1', heading: 'Product information',
      rows: [{ label: 'Brand', value: 'Synthetic brand' }] }] },
  collectionQuality: { version: 2, fields: { weight: { status: 'unavailable', reason: 'page_not_provided' } } },
  purchaseCost: null, purchaseUnitCostCny: null, supplierAverageCny: null, suppliers: [],
  ...overrides,
});

test('all twelve markets calculate preliminary profit at the minimum envelope tier without fabricating Item Weight', () => {
  for (const [marketplace, fee, currency, assumedWeightKg] of marketCases) {
    const estimate = estimateMinimumFbaFee({ marketplace, salePrice: 25 });
    assert.equal(estimate.fee, fee);
    assert.equal(estimate.currency, currency);
    assert.equal(estimate.actualWeightKg, null);
    assert.equal(estimate.assumption, 'missing_weight_minimum_fba_estimate');
    assert.equal(estimate.confidence, '低');
    const updated = recomputeProductProfit(product({ marketplace }));
    if (['AU', 'CA'].includes(marketplace)) {
      assert.equal(updated.fbaFee, null);
      assert.equal(updated.profitCalculation, null);
      assert.ok(updated.amazonMissing.includes('商品重量、包裹重量及尺寸均缺失'));
      continue;
    }
    assert.equal(updated.fbaFee, fee);
    assert.equal(updated.fbaFeeSource, 'missing_weight_minimum_fba_estimate');
    assert.equal(updated.productWeight, null);
    assert.equal(updated.billingWeight, null);
    assert.equal(updated.profitInputs.actualWeightKg, null);
    assert.equal(updated.profitInputs.assumedWeightKg, assumedWeightKg);
    assert.equal(updated.profitInputs.weightAssumption, 'missing_weight_minimum_envelope');
    assert.equal(updated.profitCalculation.isEstimate, true);
    assert.equal(updated.profitCalculation.airFreight.actualWeightKg, null);
    assert.equal(updated.profitCalculation.airFreight.chargeableWeightKg, assumedWeightKg);
    assert.equal(updated.profitCalculation.domesticFreightWeightKg, assumedWeightKg);
    assert.ok(Number.isFinite(updated.margin), marketplace);
    assert.ok(updated.amazonMissing.includes('商品重量、包裹重量及尺寸均缺失'), 'the collection still requires actual Item Weight');
    assert.equal(updated.collectionQuality.fields.weight.status, 'unavailable');
    if (!['AU', 'CA', 'US'].includes(marketplace)) assert.match(estimate.rateApplicability, /SOP.*名义|名义.*SOP/);
  }
  assert.equal(estimateMinimumFbaFee({ marketplace: 'UNKNOWN' }), null);
  assert.equal(recomputeProductProfit(product({ marketplace: 'UNKNOWN' })).fbaFee, null);
});

test('missing-weight profit is available before collection while confirmed page absence retains its stricter meaning', () => {
  assert.equal(isAmazonWeightUnavailable(product()), true);
  assert.equal(isAmazonWeightUnavailable(product({ collectionQuality: undefined })), true);
  assert.equal(isAmazonWeightUnavailable(product({ productInformation: undefined })), false);
  assert.equal(isAmazonWeightUnavailable(product({ productInformation: undefined, collectionQuality: undefined })), false);
  for (const detailStatus of ['pending', 'loading', 'running', 'retrying', 'failed', 'error', 'cancelled', undefined]) {
    const item = product({ detailStatus });
    assert.equal(isAmazonWeightUnavailable(item), false);
    const result = recomputeProductProfit(item);
    assert.equal(result.fbaFee, null);
    assert.equal(result.profitInputs.actualWeightKg, null);
    assert.equal(result.profitCalculation, null);
    assert.equal(result.detailStatus, detailStatus);
  }
  for (const overrides of [
    { collectionQuality: { fields: { weight: { status: 'missing', reason: 'not_collected' } } } },
    { collectionQuality: { fields: { weight: { status: 'invalid', reason: 'weight_not_positive' } } } },
    { challenge: true }, { rateLimited: true }, { navigationError: true },
    { collectionLastAttempt: { status: 'failed' } }, { productWeight: 0 }, { productWeight: -1 },
    { productWeight: 'invalid' }, { packageWeightKg: 0.1 },
  ]) assert.equal(isAmazonWeightUnavailable(product(overrides)), false);
});

test('a Package Weight-only page uses a separate envelope assumption without promoting packaging to Item Weight', () => {
  const item = product({ detailParserVersion: 11, fbaWeight: 0.3, packageWeightKg: 0.3,
    billingWeight: 0.3, actualWeightKg: 0.3, profitInputs: { actualWeightKg: 0.3 } });
  item.productInformation.weightSelection = { policy: 'item_weight_only' };
  item.productInformation.sections[0].rows = [{ label: 'Package Weight', value: '300 g' }];
  assert.equal(isAmazonWeightUnavailable(item), true);
  const result = recomputeProductProfit(item);
  assert.equal(result.fbaWeight, 0.3);
  assert.equal(result.productWeight, null);
  assert.equal(result.billingWeight, null);
  assert.equal(result.profitInputs.actualWeightKg, null);
  assert.equal(result.fbaEstimate, null);
  assert.equal(result.fbaFee, null);
  assert.equal(result.profitInputs.assumedWeightKg, undefined);
  assert.equal(result.profitCalculation, null);
  assert.ok(result.profitPendingReasons.includes('商品重量或包裹重量'));
});

test('a later sourced weight replaces minimum FBA and enables complete profit without modifying inputs', () => {
  const original = product({ purchaseCost: 7, manualPurchaseCost: true, manualFbaFee: false });
  const before = structuredClone(original);
  const pending = recomputeProductProfit(original);
  const weighted = recomputeProductProfit({ ...pending, productWeight: 0.3, billingWeight: 0.3,
    fieldSources: { productWeightKg: 'amazon_product_details' },
    collectionQuality: { fields: { weight: { status: 'verified', value: 0.3 } } } });
  assert.equal(weighted.fbaFee, 5.61);
  assert.equal(weighted.profitInputs.actualWeightKg, 0.3);
  assert.equal(weighted.profitCalculation.airFreight.actualWeightKg, 0.3);
  assert.ok(weighted.profitInputs.assumedWeightKg == null);
  assert.ok(weighted.profitInputs.weightAssumption == null);
  assert.notEqual(weighted.profitCalculation.isEstimate, true);
  assert.ok(Number.isFinite(weighted.margin));
  assert.deepEqual(original, before);
});

test('explicit manual fees, manual weights, procurement costs and supplier quotes remain protected', () => {
  const manual = product({ manualFbaFee: true, fbaFee: 8.88, manualSalePrice: true, salePrice: 31,
    purchaseCost: 12, manualPurchaseCost: true, suppliers: [{ offerId: 'kept', unitPriceCny: 12 }] });
  const result = recomputeProductProfit(manual);
  assert.equal(result.fbaFee, 8.88);
  assert.equal(result.salePrice, 31);
  assert.equal(result.purchaseCost, 12);
  assert.deepEqual(result.suppliers, manual.suppliers);
  const weighted = recomputeProductProfit({ ...manual, productWeight: 0.7, profitInputs: { actualWeightKg: 0.25, weightSource: '产品手工覆盖' } });
  assert.equal(weighted.billingWeight, 0.25);
  assert.equal(weighted.profitInputs.actualWeightKg, 0.25);
  assert.equal(weighted.profitCalculation.airFreight.actualWeightKg, 0.25);
  assert.equal(weighted.profitCalculation.domesticFreightWeightKg, 0.25);
  assert.equal(resolveAnalysisProfitInputs(weighted).actualWeightKg, 0.25);
  assert.ok(Number.isFinite(weighted.margin));
  const frozen = { ...manual, analysisHandoff: { owner: 'procurement', revision: 'kept' }, margin: 20 };
  assert.deepEqual(recomputeProductProfit(frozen), frozen);
});

test('50+ candidates can pass preliminary screening while only cost and price remain required profit inputs', () => {
  const item = recomputeProductProfit(product({ currentPrice: null }));
  const record = evaluateAnalysisProduct(item, { runState: { id: 'synthetic', marketplace: 'AU' } });
  assert.equal(record.filter.decision, 'pass');
  assert.equal(record.preliminary_profit.status, 'pending_inputs');
  assert.equal(record.preliminary_profit.inputs.actualWeightKg, null);
  assert.equal(record.preliminary_profit.inputs.fulfillmentFee, null);
  assert.equal(record.amazon_observations.item_weight_kg, null);
  assert.equal(record.preliminary_profit.inputs.assumedWeightKg, undefined);
  assert.ok(record.preliminary_profit.missing_inputs.includes('actualWeightKg'));
  assert.ok(record.preliminary_profit.missing_inputs.includes('purchaseCostCny'));
  assert.ok(record.preliminary_profit.missing_inputs.includes('salePrice'));
  const noSales = evaluateAnalysisProduct({ ...item, sales30Evidence: null });
  assert.equal(noSales.filter.decision, 'pending');
  assert.ok(noSales.filter.reasons.includes('MONTHLY_SALES_EVIDENCE_MISSING'));
});

test('legacy exported 75g assumption is not reused as real weight', () => {
  const input = { actualWeightKg: 0.075, actualWeightSource: 'missing_weight_lowest_freight_assumption' };
  const item = product({ analysisProfitInputs: input });
  assert.equal(resolveAnalysisProfitInputs(item).actualWeightKg, null);
  assert.equal(input.actualWeightKg, 0.075, 'the saved input itself is not mutated');
});


test('uninspected, incomplete, mismatched and unresolved information permits estimates without claiming page absence', () => {
  const complete = product().productInformation;
  const cases = [undefined, { ...complete, version: 0 }, { ...complete, asin: 'B000000002' },
    { ...complete, inspection: undefined },
    { ...complete, inspection: { ...complete.inspection, stable: false } },
    { ...complete, inspection: { ...complete.inspection, asin: 'B000000002' } },
    { ...complete, inspection: { ...complete.inspection, sections: [{ selector: '#productDetails_detailBullets_sections1', status: 'complete', rowCount: 1, closed: true }] } },
    { ...complete, status: 'incomplete', reason: 'empty_details' }, { ...complete, weightStatus: 'unresolved' },
    { ...complete, weightStatus: 'found' }, { ...complete, rowCount: 0, sections: [] },
    { ...complete, sections: [{ selector: '#productDetails', heading: 'Product information', rows: [{ label: 'Item Weight', value: 'unreadable' }] }] }];
  for (const productInformation of cases) {
    const item = product({ productInformation });
    assert.equal(isAmazonWeightUnavailable(item), false);
    const result = recomputeProductProfit(item);
    assert.equal(result.fbaFee, null); assert.equal(result.productWeight, null);
    assert.equal(result.billingWeight, null); assert.equal(result.profitCalculation, null);
    assert.deepEqual(result.productInformation, productInformation);
    const manual = recomputeProductProfit({ ...item, manualFbaFee: true, fbaFee: 2.34 });
    assert.equal(manual.fbaFee, 2.34, 'explicit manual fees remain valid even when product information needs checking');
  }
});


test('legacy page-absence claims do not block the new estimate or override a manual fee', () => {
  const legacy = product({ productInformation: undefined, manualFbaFee: false, fbaFee: 3.67,
    fbaFeeSource: 'missing_weight_minimum_fba_estimate',
    fbaEstimate: { fee: 3.67, actualWeightKg: null, assumption: 'missing_weight_minimum_fba_estimate' },
    collectionQuality: { version: 1, fields: { weight: { status: 'unavailable', reason: 'page_not_provided' } } } });
  const result = recomputeProductProfit(legacy);
  assert.equal(result.fbaFee, null);
  assert.equal(result.fbaEstimate, null);
  assert.equal(result.billingWeight, null); assert.equal(result.profitCalculation, null);
  const manual = recomputeProductProfit({ ...legacy, manualFbaFee: true, fbaFee: 8.88 });
  assert.equal(manual.fbaFee, 8.88);
});

test('manual FBA zero remains usable with unknown weight, while FBM is never assigned an envelope estimate', () => {
  const manualFba = recomputeProductProfit(product({ manualFbaFee: true, fbaFee: 0 }));
  assert.equal(manualFba.fbaFee, 0);
  assert.equal(manualFba.profitCalculation, null);
  assert.equal(manualFba.profitInputs.assumedWeightKg, undefined);
  const fbm = recomputeProductProfit(product({ fulfillmentMode: 'FBM', fbmFee: 9, manualFbmFee: true }));
  assert.equal(fbm.fulfillmentMode, 'FBM');
  assert.equal(fbm.fbmFee, 9);
  assert.equal(fbm.profitCalculation, null);
  assert.ok(fbm.profitInputs.assumedWeightKg == null);
});

test('all twelve markets persist missing-weight profit estimates and retain collection recovery metadata across restart', async () => {
  for (const [marketplace, fee, currency, assumedWeightKg] of marketCases) {
    const runId = 'minimum-' + marketplace;
    const store = new PersistenceStore({ directory: path.join(temporaryRoot, runId) });
    await store.ready();
    const recovery = { attempts: 2, status: 'exhausted', lastReason: 'inspection_timeout' };
    const original = product({ id: marketplace + ':B000000001', marketplace, currency,
      detailStatus: 'failed', detailErrorCode: 'AMAZON_NETWORK_TIMEOUT',
      productInformation: undefined, collectionQuality: { fields: { weight: { status: 'missing', reason: 'inspection_timeout' } } },
      collectionRecovery: recovery });
    const before = structuredClone(original);
    await store.saveSnapshot({ runState: { id: runId, marketplace, currency, errors: [] }, products: [original] });
    const disk = JSON.parse(await readFile(store.runPath(runId), 'utf8')).snapshot.products[0];
    const restarted = new PersistenceStore({ directory: store.directory });
    await restarted.ready();
    const restored = (await restarted.getRunSnapshot(runId)).products[0];
    assert.deepEqual(restored, disk);
    if (['AU', 'CA'].includes(marketplace)) {
      assert.equal(restored.fbaFee, null);
      assert.equal(restored.profitCalculation, null);
      assert.deepEqual(restored.collectionRecovery, recovery);
      assert.equal(restored.detailErrorCode, 'AMAZON_NETWORK_TIMEOUT');
      assert.deepEqual(original, before);
      continue;
    }
    assert.equal(restored.fbaFee, fee);
    assert.equal(restored.profitCalculation.isEstimate, true);
    assert.equal(restored.profitInputs.assumedWeightKg, assumedWeightKg);
    assert.equal(restored.productWeight, null);
    assert.equal(restored.billingWeight, null);
    assert.equal(restored.profitInputs.actualWeightKg, null);
    assert.deepEqual(restored.collectionRecovery, recovery);
    assert.equal(restored.detailErrorCode, 'AMAZON_NETWORK_TIMEOUT');
    assert.deepEqual(original, before);
  }
});

test('v11 to v12 persisted recompute preserves every saved rate, manual fee, price, cost, quote and handed-off product', async () => {
  const runId = 'preserve-manual-v11';
  const store = new PersistenceStore({ directory: path.join(temporaryRoot, runId) });
  await store.ready();
  const rates = { exchangeRate: 4.91, commissionRate: 15, fxLossRate: 2.3, marketingRate: 12,
    managementRate: 5, returnsRate: 8, purchaseTaxRate: 7, domesticFreightRateCnyPerKg: 3,
    airFreightRateCnyPerKg: 60, volumetricDivisor: 167 };
  const original = product({ manualSalePrice: true, salePrice: 31, manualFbaFee: true, fbaFee: 8.88,
    manualPurchaseCost: true, purchaseCost: 12, purchaseUnitCostCny: 12,
    supplierAverageCny: 19, suppliers: [{ offerId: 'kept', unitPriceCny: 19 }],
    profitInputs: { formulaVersion: 'profit-workbook-au-ca-envelope-capped-fba-v11', ...rates } });
  const frozen = product({ id: 'AU:B000000002', asin: 'B000000002', sourceAsin: 'B000000002',
    analysisHandoff: { owner: 'procurement', revision: 3 }, margin: 20,
    profitInputs: { formulaVersion: 'profit-workbook-au-ca-envelope-capped-fba-v11', ...rates } });
  await store.saveSnapshot({ runState: { id: runId, marketplace: 'AU', errors: [] }, products: [original, frozen] });
  const saved = (await store.getRunSnapshot(runId)).products;
  const result = saved[0];
  assert.equal(result.profitInputs.formulaVersion, PROFIT_FORMULA_VERSION);
  assert.equal(PROFIT_FORMULA_VERSION, 'profit-workbook-all-market-minimum-envelope-v12');
  for (const [key, value] of Object.entries(rates)) assert.equal(result.profitInputs[key], value, key);
  for (const key of ['salePrice', 'fbaFee', 'purchaseCost', 'purchaseUnitCostCny', 'supplierAverageCny']) assert.equal(result[key], original[key], key);
  assert.deepEqual(result.suppliers, original.suppliers);
  assert.equal(result.profitCalculation, null);
  assert.deepEqual(saved[1], frozen);
});

test('an actual Item Weight arrival replaces a persisted assumption through the background collection transaction', async () => {
  const runId = 'collected-item-weight';
  const asin = 'B000000001';
  const store = new PersistenceStore({ directory: path.join(temporaryRoot, runId) });
  await store.ready();
  await store.saveSnapshot({ runState: { id: runId, marketplace: 'CA', errors: [] }, products: [product({
    id: 'CA:' + asin, marketplace: 'CA', detailParserVersion: 11,
    detailStatus: 'failed', productInformation: undefined, purchaseCost: 7, manualPurchaseCost: true,
  })] });
  const estimated = (await store.getRunSnapshot(runId)).products[0];
  assert.equal(estimated.profitCalculation, null);
  await store.updateAmazonCollection(runId, () => ({
    job: { runId, status: 'completed', revision: 1 },
    items: { [asin]: { asin, sourceAsin: asin, marketplace: 'CA', title: 'Synthetic candidate',
      detailStatus: 'success', detailParserVersion: 11, currentPrice: 25,
      productWeightKg: 0.3, productWeightEvidence: { label: 'Item Weight', kind: 'product', value: 0.3, rawText: '300 g' },
      fieldSources: { productWeightKg: 'amazon_product_details' },
      collectionQuality: { fields: { weight: { status: 'verified', value: 0.3 } } },
    } },
  }), { activate: true });
  const committed = JSON.parse(await readFile(store.runPath(runId), 'utf8')).snapshot.products[0];
  assert.equal(committed.productWeight, 0.3);
  assert.equal(committed.billingWeight, 0.3);
  assert.equal(committed.profitInputs.actualWeightKg, 0.3);
  assert.equal(committed.profitCalculation.airFreight.actualWeightKg, 0.3);
  assert.equal(committed.profitCalculation.domesticFreightWeightKg, 0.3);
  assert.ok(committed.profitInputs.assumedWeightKg == null);
  assert.ok(committed.profitCalculation.assumedWeightKg == null);
  assert.notEqual(committed.profitCalculation.isEstimate, true);
  assert.equal(committed.fbaFee, 5.31 * 1.035);
  assert.equal(committed.purchaseCost, 7);
  assert.deepEqual((await store.getRunSnapshot(runId)).products[0], committed);
});
