import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonProductPage } from '../lib/amazon-store-client.mjs';
import { automaticProductWeightKg, automaticPackageWeightKg, automaticProfitWeightKg, profitWeightSourceLabel } from '../lib/profit-model.mjs';
import { auditAmazonProductFields } from '../lib/amazon-detail-quality.mjs';
import { recomputeProductProfit } from '../lib/product-profit-state.mjs';
import { evaluateAnalysisProduct } from '../lib/analysis-handoff.mjs';

const asin = 'B0GCDRLJZS';
const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
const parse = body => ({ ...parseAmazonProductPage(`<input id="ASIN" value="${asin}"><h1 id="productTitle">5PCS Girls Bow Headbands</h1>${body}`,
  { marketplace: 'CA', asin, collectionStrategy: 'v0.9.50-single-page' }), detailStatus: 'success', detailParserVersion: 13, marketplace: 'CA' });
const bullet = '<div id="detailBullets_feature_div"><ul><li><b>Parcel Dimensions :</b> 16.5 x 15 x 1.9 cm; 60 g</li></ul></div>';
const table = rows => `<div id="productDetails_feature_div"><table>${rows}</table></div>`;

test('the reported Parcel Dimensions 60g is package evidence, never Item Weight', () => {
  const product = parse(bullet);
  assert.equal(product.productWeightKg, null);
  assert.equal(product.packageWeightKg, .06);
  assert.equal(automaticProductWeightKg(product), null);
  assert.equal(automaticProfitWeightKg(product), .06);
  assert.match(profitWeightSourceLabel(product), /包裹重量/);
  assert.equal(product.packageWeightEvidence.rawText, '16.5 x 15 x 1.9 cm; 60 g');
  const quality = auditAmazonProductFields(product).fields.weight;
  assert.equal(quality.status, 'verified');
  assert.equal(quality.kind, 'package');
  assert.equal(quality.retryable, false);
});

for (const [itemGrams, expected, label] of [[40, .06, '包裹重量'], [80, .08, 'Item Weight'], [60, .06, 'Item Weight']]) {
  test(`profit selects the heavier of Item Weight ${itemGrams}g and package 60g, with deterministic ties`, () => {
    const product = parse(bullet + table(row('Item Weight', `${itemGrams} g`)));
    assert.equal(automaticProfitWeightKg(product), expected);
    assert.equal(automaticProductWeightKg(product), itemGrams / 1000);
    assert.equal(automaticPackageWeightKg(product), .06);
    assert.match(profitWeightSourceLabel(product), new RegExp(label));
    const calculated = recomputeProductProfit({ ...product, productWeight: itemGrams / 1000, fbaWeight: .06,
      manualSalePrice: true, salePrice: 19.99, currentPrice: 19.99,
      manualPurchaseCost: true, purchaseCost: 2, purchaseUnitCostCny: 2, pieceCount: 1, pieceCountSource: 'manual',
      fulfillmentMode: 'FBA', fulfillmentModeSource: 'manual' });
    assert.equal(calculated.billingWeight, expected);
    assert.equal(calculated.profitCalculation.airFreight.actualWeightKg, expected);
    assert.match(calculated.weightSource, new RegExp(label));
    const exported = evaluateAnalysisProduct(calculated, { runState: { marketplace: 'CA', inputMode: 'asins' } });
    assert.equal(exported.preliminary_profit.inputs.actualWeightKg, expected);
    assert.equal(exported.amazon_observations.item_weight_kg, itemGrams / 1000);
    assert.equal(exported.amazon_observations.package_weight_kg, .06);
    assert.match(exported.preliminary_profit.inputs.weightSource, new RegExp(label));
  });
}

for (const heading of ['Product information', 'Item details', 'Measurements']) {
  test(`${heading}: heavier package weight wins regardless of section order and missing dimensions`, () => {
    const main = `<div id="productDetails_feature_div"><div class="a-expander-container"><a class="a-expander-header">${heading}</a><div class="a-expander-content" style="display:none"><table>${row('Item Weight', '40 g')}</table></div></div></div>`;
    for (const body of [bullet + main, main + bullet]) {
      const product = parse(body);
      assert.equal(automaticProfitWeightKg(product), .06);
      assert.equal(automaticPackageWeightKg(product), .06);
      assert.equal(auditAmazonProductFields(product).fields.weight.kind, 'product');
    }
  });
}

test('Product details bullets retain explicit package mass', () => {
  const result = parse('<div id="detailBulletsWrapper_feature_div"><ul><li><b>Package Weight:</b> 70 g</li></ul></div>');
  assert.equal(automaticProfitWeightKg(result), .07);
});

test('dimensions alone, capacity, recommendations and unproven package caches never become profit weight', () => {
  for (const body of [table(row('Parcel Dimensions', '16.5 x 15 x 1.9 cm')),
    table(row('Load Capacity', '60 kg')), table(row('Product Dimensions', '16 x 15 x 2 cm; 60 g')),
    `<div id="recommendations">${bullet}</div>`, `<div hidden>${bullet}</div>`,
    '<div id="productDescription">Package Weight: 60 g</div>']) {
    assert.equal(automaticProfitWeightKg(parse(body)), null);
  }
  const original = parse(bullet);
  for (const evidence of [null, { ...original.packageWeightEvidence, value: .5 },
    { ...original.packageWeightEvidence, asin: 'B000000001' }, { ...original.packageWeightEvidence, label: 'Load Capacity' }]) {
    assert.equal(automaticProfitWeightKg({ ...original, packageWeightEvidence: evidence, billingWeight: .5 }), null);
  }
});

test('profit, FBA and exported observations keep package fallback distinct and allow a heavier Item Weight to replace it', () => {
  const base = { ...parse(bullet), id: `CA:${asin}`, sourceAsin: asin, productWeight: null, fbaWeight: .06,
    salePrice: 19.99, currentPrice: 19.99, manualSalePrice: true, manualPurchaseCost: true,
    purchaseCost: 2, purchaseUnitCostCny: 2, pieceCount: 1, pieceCountSource: 'manual',
    fulfillmentMode: 'FBA', fulfillmentModeSource: 'manual', suppliers: [{ unitPriceCny: 2 }] };
  const fallback = recomputeProductProfit(base);
  assert.equal(fallback.productWeight, null);
  assert.equal(fallback.billingWeight, .06);
  assert.equal(fallback.profitInputs.actualWeightKg, .06);
  assert.equal(fallback.profitCalculation.airFreight.actualWeightKg, .06);
  assert.equal(fallback.profitCalculation.weightAssumption, undefined);
  assert.match(fallback.weightSource, /包裹重量/);
  const exported = evaluateAnalysisProduct(fallback, { runState: { marketplace: 'CA', inputMode: 'asins' } });
  assert.equal(exported.amazon_observations.item_weight_kg, null);
  assert.equal(exported.amazon_observations.package_weight_kg, .06);
  assert.equal(exported.preliminary_profit.inputs.actualWeightKg, .06);
  assert.match(exported.preliminary_profit.inputs.weightSource, /包裹重量/);
  const fresh = parse(bullet + table(row('Item Weight', '80 g')));
  const updated = recomputeProductProfit({ ...fallback, productWeight: .08, productWeightEvidence: fresh.productWeightEvidence });
  assert.equal(updated.billingWeight, .08);
  assert.equal(updated.profitCalculation.airFreight.actualWeightKg, .08);
  assert.match(updated.weightSource, /Item Weight/);
  const manual = recomputeProductProfit({ ...fallback, manualBillingWeight: true, billingWeight: .2 });
  assert.equal(manual.billingWeight, .2);
  assert.equal(manual.purchaseCost, fallback.purchaseCost);
  assert.deepEqual(manual.suppliers, fallback.suppliers);
});
