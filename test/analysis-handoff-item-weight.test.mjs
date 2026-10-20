import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisHandoffPackage, evaluateAnalysisProduct, resolveAnalysisProfitInputs } from '../lib/analysis-handoff.mjs';
import { DEFAULT_PROFIT_RATES } from '../lib/profit-model.mjs';

const runState = { id: 'item-weight-export', marketplace: 'AU', inputMode: 'asins' };
const inputs = { ...DEFAULT_PROFIT_RATES, salePrice: 25, purchaseCostCny: 8,
  fulfillmentMode: 'FBA', fulfillmentFee: 4.35, exchangeRate: 4.8,
  actualWeightKg: 0.5, airFreightActualWeightOnly: true, volumetricDivisor: 139 };
const product = extra => ({ id: 'AU:B000000001', asin: 'B000000001', sourceAsin: 'B000000001',
  marketplace: 'AU', detailStatus: 'success', detailParserVersion: 11, name: 'Weight export example',
  currentPrice: 25, salePrice: 25, purchaseCost: 8, manualPurchaseCost: true, reviewStatus: 'approved',
  sales30: 50, sales30Evidence: { source: 'amazon_product_page', period: 'past_month',
    kind: 'lower_bound', value: 50, rawText: '50+ bought in past month', asin: 'B000000001' },
  productWeight: 0.5, fbaWeight: 0.5, billingWeight: 0.5, actualWeightKg: 0.5,
  productWeightEvidence: { label: 'Package Weight', kind: 'package', value: 0.5, unit: 'kg' },
  analysisProfitInputs: { ...inputs }, suppliers: [{ offerId: 'saved-quote', unitPriceCny: 8 }],
  ...extra });

test('new Item Weight policy prevents stale resolved, billing and package values from entering handoff profit or observations', () => {
  for (const policy of [{ detailParserVersion: 11 },
    { detailParserVersion: 10, productInformation: { weightSelection: { policy: 'item_weight_only' } } },
    { detailParserVersion: 10, weightSelection: { policy: 'item_weight_only' } }]) {
    for (const mode of ['analysisProfitInputs', 'resolvedProfitInputs', 'profitInputs']) {
      const item = product({ ...policy, analysisProfitInputs: undefined, [mode]: { ...inputs } });
      const original = structuredClone(item);
      const record = evaluateAnalysisProduct(item, { runState });
      assert.equal(record.amazon_observations.item_weight_kg, null, mode);
      assert.equal(record.preliminary_profit.inputs.actualWeightKg, null, mode);
      assert.equal(record.preliminary_profit.inputs.assumedWeightKg, undefined, mode);
      assert.equal(record.preliminary_profit.result, null, mode);
      assert.ok(record.preliminary_profit.missing_inputs.includes('actualWeightKg'));
      assert.equal(record.filter.decision, 'pass', 'Missing weight does not invent a mass or exclude a sales-qualified ASIN.');
      assert.deepEqual(item, original);
    }
  }
});

test('fresh Item Weight supersedes an old resolved mass and a missing listing date does not block profit calculation', () => {
  const item = product({ productWeight: 0.17,
    productWeightEvidence: { label: 'Item Weight', kind: 'product', value: 0.17, unit: 'kg' },
    amazonFirstAvailableDateStatus: 'unresolved' });
  const record = createAnalysisHandoffPackage({ runState, products: [item] }).products[0];
  assert.equal(record.amazon_observations.item_weight_kg, 0.17);
  assert.equal(record.amazon_observations.first_available_date, null);
  assert.equal(record.preliminary_profit.inputs.actualWeightKg, 0.17);
  assert.equal(record.preliminary_profit.status, 'calculated_estimate');
  assert.ok(record.preliminary_profit.result);
});

test('explicit manual weight, price, cost and quotes survive the new handoff policy', () => {
  for (const manual of [
    { manualBillingWeight: true, billingWeight: 0.2 },
    { profitInputs: { ...inputs, actualWeightKg: 0.2, weightSource: '产品人工覆盖' } },
    { analysisProfitInputs: { ...inputs, actualWeightKg: 0.2, weightSource: 'product_manual' } },
  ]) {
    const item = product(manual), original = structuredClone(item);
    const record = createAnalysisHandoffPackage({ runState, products: [item] }).products[0];
    assert.equal(record.preliminary_profit.inputs.actualWeightKg, 0.2);
    assert.equal(record.preliminary_profit.inputs.salePrice, 25);
    assert.equal(record.preliminary_profit.inputs.purchaseCostCny, 8);
    assert.equal(record.preliminary_profit.status, 'calculated_estimate');
    assert.equal(record.amazon_observations.item_weight_kg, null, 'A manual mass must not be labeled an Amazon Item Weight observation.');
    assert.deepEqual(item, original);
  }
});

test('legacy handoff inputs keep their existing policy until a new Item Weight-only observation arrives', () => {
  const item = product({ detailParserVersion: 10 });
  assert.equal(resolveAnalysisProfitInputs(item).actualWeightKg, 0.5);
  assert.equal(evaluateAnalysisProduct(item, { runState }).amazon_observations.item_weight_kg, 0.5);
});
