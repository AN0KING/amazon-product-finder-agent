import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateMinimumFbaFee, isAmazonWeightUnavailable } from '../lib/profit-model.mjs';
import { recomputeProductProfit } from '../lib/product-profit-state.mjs';
import { evaluateAnalysisProduct, resolveAnalysisProfitInputs } from '../lib/analysis-handoff.mjs';

const product = (overrides = {}) => ({
  id: 'AU:B000000001', asin: 'B000000001', sourceAsin: 'B000000001', marketplace: 'AU',
  analysisSourceMode: 'amazon_only', detailStatus: 'success', currentPrice: 25, productWeight: null, billingWeight: null,
  name: 'Synthetic candidate', englishName: 'Synthetic candidate', imageUrl: 'https://example.com/product.jpg',
  sales30: 50, sales30Evidence: { asin: 'B000000001', source: 'amazon_product_page', kind: 'lower_bound',
    period: 'past_month', value: 50, rawText: '50+ bought in past month' },
  collectionQuality: { fields: { weight: { status: 'unavailable', reason: 'page_not_provided' } } },
  purchaseCost: null, purchaseUnitCostCny: null, supplierAverageCny: null, suppliers: [],
  ...overrides,
});

test('configured AU, CA and US minimum fees do not claim a collected or chargeable product weight', () => {
  for (const [marketplace, fee, currency] of [['AU', 4.58, 'AUD'], ['CA', 4.73 * 1.035, 'CAD'], ['US', 3.22, 'USD']]) {
    const estimate = estimateMinimumFbaFee({ marketplace, salePrice: 25 });
    assert.equal(estimate.fee, fee);
    assert.equal(estimate.currency, currency);
    assert.equal(estimate.actualWeightKg, null);
    assert.equal(estimate.assumption, 'missing_weight_minimum_fba_estimate');
    assert.equal(estimate.confidence, '低');
    const updated = recomputeProductProfit(product({ marketplace }));
    assert.equal(updated.fbaFee, fee);
    assert.equal(updated.fbaFeeSource, 'missing_weight_minimum_fba_estimate');
    assert.equal(updated.productWeight, null);
    assert.equal(updated.billingWeight, null);
    assert.equal(updated.profitInputs.actualWeightKg, null);
    assert.equal(updated.profitCalculation, null);
    assert.equal(updated.margin, null);
  }
  for (const marketplace of ['NL', 'UK', 'DE', 'UNKNOWN']) {
    assert.equal(estimateMinimumFbaFee({ marketplace }), null);
    assert.equal(recomputeProductProfit(product({ marketplace })).fbaFee, null);
  }
});

test('missing weight is eligible for minimum FBA only after a successful page confirms absence', () => {
  assert.equal(isAmazonWeightUnavailable(product()), true);
  assert.equal(isAmazonWeightUnavailable(product({ collectionQuality: undefined })), true);
  for (const detailStatus of ['pending', 'loading', 'running', 'retrying', 'failed', 'error', 'cancelled', undefined]) {
    const item = product({ detailStatus });
    assert.equal(isAmazonWeightUnavailable(item), false);
    assert.equal(recomputeProductProfit(item).fbaFee, null);
  }
  for (const overrides of [
    { collectionQuality: { fields: { weight: { status: 'missing', reason: 'not_collected' } } } },
    { collectionQuality: { fields: { weight: { status: 'invalid', reason: 'weight_not_positive' } } } },
    { challenge: true }, { rateLimited: true }, { navigationError: true },
    { collectionLastAttempt: { status: 'failed' } }, { productWeight: 0 }, { productWeight: -1 },
    { productWeight: 'invalid' }, { packageWeightKg: 0.1 },
  ]) assert.equal(isAmazonWeightUnavailable(product(overrides)), false);
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

test('50+ candidates can pass preliminary screening while cost, price and weight-dependent profit remain pending', () => {
  const item = recomputeProductProfit(product({ currentPrice: null }));
  const record = evaluateAnalysisProduct(item, { runState: { id: 'synthetic', marketplace: 'AU' } });
  assert.equal(record.filter.decision, 'pass');
  assert.equal(record.preliminary_profit.status, 'pending_inputs');
  assert.equal(record.preliminary_profit.inputs.actualWeightKg, null);
  assert.equal(record.preliminary_profit.inputs.fulfillmentFee, 3.67);
  assert.equal(record.amazon_observations.item_weight_kg, null);
  assert.ok(record.preliminary_profit.missing_inputs.includes('actualWeightKg'));
  assert.ok(record.preliminary_profit.missing_inputs.includes('purchaseCostCny'));
  assert.ok(record.preliminary_profit.missing_inputs.includes('salePrice'));
  const noSales = evaluateAnalysisProduct({ ...item, sales30Evidence: null });
  assert.equal(noSales.filter.decision, 'excluded');
  assert.ok(noSales.filter.reasons.includes('MONTHLY_SALES_EVIDENCE_MISSING'));
});

test('legacy exported 75g assumption is not reused as real weight', () => {
  const input = { actualWeightKg: 0.075, actualWeightSource: 'missing_weight_lowest_freight_assumption' };
  const item = product({ analysisProfitInputs: input });
  assert.equal(resolveAnalysisProfitInputs(item).actualWeightKg, null);
  assert.equal(input.actualWeightKg, 0.075, 'the saved input itself is not mutated');
});
