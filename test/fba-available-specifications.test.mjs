import test from 'node:test';
import assert from 'node:assert/strict';
import { canadaDimensionalWeightKg, parseProductDimensionsCm, resolveProductDimensionsCm,
  estimateFbaByAvailableSpecifications, hasAnyProductShippingSpecification, marketDimensionalWeightKg, selectCorroboratedFbaFee, fbaSelectionExplanation } from '../lib/profit-model.mjs';
import { recomputeProductProfit } from '../lib/product-profit-state.mjs';
import { resolveAnalysisProfitInputs, evaluateAnalysisProduct } from '../lib/analysis-handoff.mjs';

const base = (item, packed, dimensions, marketplace = 'CA') => ({
  id: 'CA:B000000001', asin: 'B000000001', sourceAsin: 'B000000001', marketplace,
  detailParserVersion: 13, analysisSourceMode: 'amazon_only',
  name: 'Test product', sellerId: 'A123456789', imageUrl: 'https://example.com/a.jpg', rating: 4.5, reviews: 8,
  productWeight: item, fbaWeight: packed, productDimensions: dimensions,
  productWeightEvidence: item ? { kind: 'product', label: 'Item Weight', value: item } : null,
  packageWeightEvidence: packed ? { kind: 'package', label: 'Package Weight', value: packed,
    asin: 'B000000001', source: 'amazon_product_page', rawText: `${packed} kg`, selector: '#productDetails' } : null,
  salePrice: 20, currentPrice: 20, manualSalePrice: true,
  purchaseCost: 2, purchaseUnitCostCny: 2, manualPurchaseCost: true, pieceCount: 1, pieceCountSource: 'manual',
  fulfillmentMode: 'FBA', fulfillmentModeSource: 'manual',
});

test('CA uses exact confirmed cm formula and converts inch/mm inputs correctly', () => {
  assert.equal(canadaDimensionalWeightKg([20, 10, 5]), 1000 / 5021.69);
  assert.deepEqual(parseProductDimensionsCm('10 x 5 x 2 inches; 60 g'), [25.4, 12.7, 5.08]);
  assert.deepEqual(parseProductDimensionsCm('100 × 50 × 20 mm'), [10, 5, 2]);
  for (const input of ['20 x 10', '0 x 10 x 5 cm', 'capacity 50 kg', 'unknown']) assert.equal(parseProductDimensionsCm(input), null);
  assert.equal(canadaDimensionalWeightKg([1e200, 1e200, 1e200]), null);
});

test('CA evaluates all three fees, chooses dimensional fee, and preserves raw observations', () => {
  const product = base(.05, .12, '20 x 10 x 6 cm');
  const result = recomputeProductProfit(product);
  assert.equal(result.fbaEstimate.selectedWeightSource, 'dimensional');
  assert.equal(result.fbaEstimate.calculationWeightKg, 1200 / 5021.69);
  assert.equal(result.fbaEstimate.feeCandidates.length, 3);
  assert.equal(result.fbaFee, Math.max(...result.fbaEstimate.feeCandidates.map(candidate => candidate.fee)));
  assert.equal(result.profitCalculation.fulfillmentFee, result.fbaFee);
  assert.equal(result.productWeight, .05);
  assert.equal(result.fbaWeight, .12);
  assert.equal(result.billingWeight, .12);
  assert.equal(result.complete, true);
  assert.equal(recomputeProductProfit(result).fbaFee, result.fbaFee);
});

test('CA real package mass can win; equal capped fees retain item-first tie order', () => {
  const packed = recomputeProductProfit(base(.05, .4, '20 x 10 x 5 cm'));
  assert.equal(packed.fbaEstimate.selectedWeightSource, 'package');
  const capped = recomputeProductProfit(base(.6, .8, '30 x 30 x 30 cm'));
  assert.equal(capped.fbaEstimate.selectedWeightSource, 'item');
  assert.equal(new Set(capped.fbaEstimate.feeCandidates.map(candidate => candidate.fee)).size, 1);
});

test('CA dimensions alone allow preliminary profit and export without inventing real weight', () => {
  const result = recomputeProductProfit(base(null, null, '20 x 10 x 5 cm'));
  assert.equal(result.billingWeight, null);
  assert.equal(result.profitInputs.actualWeightKg, null);
  assert.equal(result.productWeight, null);
  assert.equal(result.fbaWeight, null);
  assert.equal(result.fbaEstimate.selectedWeightSource, 'dimensional');
  assert.equal(result.profitCalculation.dimensionalWeightEstimateKg, 1000 / 5021.69);
  assert.ok(Number.isFinite(result.margin));
  assert.deepEqual(result.missing, []);
  assert.equal(result.profitCalculation.domesticFreightWeightSource, 'dimensional_weight_estimate');
  const inputs = resolveAnalysisProfitInputs(result);
  assert.equal(inputs.actualWeightKg, null);
  assert.equal(inputs.dimensionalWeightEstimateKg, 1000 / 5021.69);
  const exported = evaluateAnalysisProduct(result, { runState: { marketplace: 'CA', inputMode: 'asins' } });
  assert.ok(exported.preliminary_profit);
});

test('one valid mass suffices without dimensions; all three absent remain incomplete', () => {
  for (const market of ['AU', 'CA']) {
    for (const [item, packed] of [[.05, null], [null, .12]]) {
      const result = recomputeProductProfit(base(item, packed, null, market));
      assert.ok(Number.isFinite(result.margin));
      assert.deepEqual(result.missing, []);
    }
    const result = recomputeProductProfit(base(null, null, null, market));
    assert.equal(result.fbaFee, null);
    assert.equal(result.margin, null);
    assert.ok(result.amazonMissing.includes('商品重量、包裹重量及尺寸均缺失'));
  }
});

test('AU includes dimensional FBA mass, preserving real-mass freight rules', () => {
  const product = base(.05, .12, '20 x 10 x 2 cm', 'AU');
  const result = recomputeProductProfit(product);
  assert.equal(result.fbaEstimate.selectedWeightSource, 'package');
  assert.equal(result.fbaEstimate.dimensionalWeightKg, 400 / 6000);
  assert.equal(result.profitCalculation.airFreight.volumetricWeightKg, null);
  const dimensionsOnly = recomputeProductProfit(base(null, null, '20 x 10 x 2 cm', 'AU'));
  assert.equal(hasAnyProductShippingSpecification(dimensionsOnly), true);
  assert.ok(Number.isFinite(dimensionsOnly.fbaFee));
  assert.ok(Number.isFinite(dimensionsOnly.margin));
  assert.equal(dimensionsOnly.productWeight, null);
  assert.equal(dimensionsOnly.profitInputs.actualWeightKg, null);
  assert.equal(dimensionsOnly.profitCalculation.domesticFreightWeightKg, 400 / 6000);
  assert.equal(dimensionsOnly.profitCalculation.airFreight.chargeableWeightKg, 400 / 6000);
});

test('manual weights and FBA fees retain priority and original values', () => {
  const product = base(.05, .12, '20 x 10 x 5 cm');
  const result = recomputeProductProfit({ ...product, manualFbaFee: true, fbaFee: 1.23,
    manualBillingWeight: true, billingWeight: .07 });
  assert.equal(result.fbaFee, 1.23);
  assert.equal(result.billingWeight, .07);
  assert.equal(result.profitCalculation.fulfillmentFee, 1.23);
  assert.equal(result.purchaseCost, product.purchaseCost);
});

test('existing single-page Product information rows supply dimensions without extra navigation', () => {
  const product = base(.05, null, null);
  product.productInformation = { sections: [{ rows: [
    { label: 'Product Dimensions', value: '20 x 10 x 5 cm; 50 g' },
    { label: 'Parcel Dimensions', value: '40 x 30 x 20 cm; 120 g' },
  ] }] };
  assert.deepEqual(resolveProductDimensionsCm(product), [20, 10, 5]);
  assert.equal(recomputeProductProfit(product).fbaEstimate.selectedWeightSource, 'dimensional');
  product.productInformation.sections[0].rows = [{ label: 'Load Capacity', value: '20 x 10 x 5 cm' }];
  assert.equal(resolveProductDimensionsCm(product), null);
});

test('fee corroboration selects highest supported fee and rejects isolated values', () => {
  for (const [fees, expected, status] of [
    [[12,10,5],12,'corroborated'], [[20,10,8],10,'outlier_excluded'],
    [[20,10,6],null,'fee_conflict'], [[10,7],10,'corroborated'],
    [[10.0001,7],null,'fee_conflict'], [[10],10,'single_source_estimate'],
    [[10,10,10],10,'corroborated'], [[],null,'missing'],
  ]) {
    const result=selectCorroboratedFbaFee(fees.map((fee,i)=>({fee,source:i})));
    assert.equal(result.selected?.fee ?? null,expected);
    assert.equal(result.status,status);
  }
  assert.equal(selectCorroboratedFbaFee([{fee:10,source:'item'},{fee:10,source:'package'}]).selected.source,'item');
});
test('single-source explanations and AU dimensional units are explicit', () => {
  assert.equal(marketDimensionalWeightKg([20,10,5],'AU'),1000/6000);
  for (const market of ['AU','CA']) {
    const result=recomputeProductProfit(base(null,.04,null,market));
    assert.equal(result.fbaEstimate.selectionStatus,'single_source_estimate');
    assert.match(fbaSelectionExplanation(result.fbaEstimate),/仅有包裹重量依据，缺少交叉核验/);
    assert.ok(Number.isFinite(result.margin));
  }
});
