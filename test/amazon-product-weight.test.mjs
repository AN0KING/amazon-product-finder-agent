import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAmazonProductPage } from '../lib/amazon-store-client.mjs';
import { mergeAmazonCollectionProduct } from '../lib/amazon-collection-merge.mjs';
const asin = 'B0A0000001';
const parse = body => parseAmazonProductPage('<input id="ASIN" value="' + asin + '"><h1 id="productTitle">Sample</h1>' + body, { marketplace: 'AU', asin });

test('Item details, technical details and Facts layouts retain exact product and package weights', () => {
  for (const root of ['itemDetails_feature_div', 'productFactsDesktopExpander', 'productFactsMobileExpander', 'productDetails_feature_div']) {
    const result = parse('<section id="' + root + '"><table><tr><th>Item Weight</th><td>125 g</td></tr><tr><th>Package Weight</th><td>0.18 kilograms</td></tr></table></section>');
    assert.equal(result.productWeightKg, 0.125, root);
    assert.equal(result.packageWeightKg, 0.18, root);
    assert.deepEqual(result.productWeightEvidence, { source: 'amazon_product_page', label: 'item weight', rawText: '125 g', selector: '#' + root, value: 0.125, unit: 'kg', asin, kind: 'product' });
    assert.equal(result.packageWeightEvidence.kind, 'package');
  }
  const row = parse('<section id="productFactsMobile_feature_div"><div role="row"><span role="cell">Item Weight</span><span role="cell">2 ounces</span></div></section>');
  assert.equal(row.productWeightKg, 0.056699);
  const definition = parse('<section id="itemDetails_feature_div"><dl><dt>Item Weight</dt><dd>0.2 lb</dd></dl></section>');
  assert.equal(definition.productWeightKg, 0.090718);
});

test('inline product and package labels select their adjacent quantities, not unrelated earlier units', () => {
  const result = parse('<div id="productDescription">Supports up to 10 kg. Net Weight: 90 g; Package Weight: 130 g.</div>');
  assert.equal(result.productWeightKg, 0.09);
  assert.equal(result.packageWeightKg, 0.13);
  assert.equal(result.productWeightEvidence.rawText, 'Net Weight: 90 g');
  assert.equal(result.packageWeightEvidence.rawText, 'Package Weight: 130 g');
});

test('an inline package weight cannot invent a product weight and vice versa', () => {
  const packageOnly = parse('<div id="productDescription">Package Weight: 0.2 lb</div>');
  assert.equal(packageOnly.productWeightKg, null);
  assert.equal(packageOnly.productWeightEvidence, null);
  assert.equal(packageOnly.packageWeightKg, 0.090718);
  const productOnly = parse('<div id="productDescription">Item Weight: 125 g</div>');
  assert.equal(productOnly.productWeightKg, 0.125);
  assert.equal(productOnly.packageWeightKg, null);
  assert.equal(productOnly.packageWeightEvidence, null);
});

test('dimension rows distinguish embedded item mass from parcel mass and never treat size as weight', () => {
  const result = parse('<div id="detailBullets_feature_div"><ul><li><b>Product Dimensions:</b> 12 x 4 x 2 cm; 60 g</li><li><b>Parcel Dimensions:</b> 14 x 5 x 3 cm; 80 g</li></ul></div>');
  assert.equal(result.productWeightKg, 0.06);
  assert.equal(result.packageWeightKg, 0.08);
  assert.equal(result.productWeightEvidence.label, 'product dimensions');
  const absent = parse('<table id="productDetails_techSpec_section_1"><tr><th>Product Dimensions</th><td>20 x 10 x 4 cm</td></tr></table>');
  assert.equal(absent.productWeightKg, null);
  assert.equal(absent.packageWeightKg, null);
});

test('hidden, comparison, recommendation and other-ASIN weights cannot fill a missing current-product weight', () => {
  for (const wrapper of ['hidden', 'id="recommendations"', 'id="comparison"', 'data-asin="B0A0000009"']) {
    const result = parse('<div ' + wrapper + '><table id="productDetails_detailBullets_sections1"><tr><th>Item Weight</th><td>999 g</td></tr></table></div>');
    assert.equal(result.productWeightKg, null, wrapper);
  }
  const nested = parse('<div id="productDescription">Description <div data-asin="B0A0000009">Item Weight: 999 g</div></div>');
  assert.equal(nested.productWeightKg, null);
  assert.equal(parse('<div id="productDescription">Maximum weight: 100 kg</div>').productWeightKg, null);
});

test('weights accept standard JSON-LD unit codes only for the current product', () => {
  for (const [unitCode, value, expected] of [['GRM', 120, 0.12], ['KGM', 0.2, 0.2], ['ONZ', 2, 0.056699], ['LBR', 0.2, 0.090718]]) {
    const json = { '@type': 'Product', sku: asin, name: 'Sample', weight: { value, unitCode } };
    const result = parse('<script type="application/ld+json">' + JSON.stringify(json) + '</script>');
    assert.equal(result.productWeightKg, expected, unitCode);
    assert.equal(result.packageWeightKg, null);
    assert.equal(result.productWeightEvidence.source, 'matching_product_json_ld');
  }
});

test('missing page weights stay null and never fabricate a verified minimum weight', () => {
  const result = parse('<div id="itemDetails_feature_div"><p>No weight supplied</p></div>');
  assert.equal(result.productWeightKg, null);
  assert.equal(result.packageWeightKg, null);
  assert.equal(result.productWeightEvidence, null);
  assert.equal(result.packageWeightEvidence, null);
  assert.equal(result.fieldSources.productWeightKg, undefined);
});

test('merged weight evidence remains separate and cannot overwrite manual weight provenance', () => {
  const parsed = parse('<div id="productDescription">Item Weight: 125 g; Package Weight: 150 g</div>');
  const item = { ...parsed, marketplace: 'AU', detailStatus: 'success' };
  const base = { id: 'AU:' + asin, asin, marketplace: 'AU', suppliers: [{ unitPriceCny: 25 }], manualPurchaseCost: true, purchaseCost: 25 };
  const merged = mergeAmazonCollectionProduct(base, item);
  assert.deepEqual(merged.productWeightEvidence, parsed.productWeightEvidence);
  assert.deepEqual(merged.packageWeightEvidence, parsed.packageWeightEvidence);
  assert.equal(merged.productWeight, 0.125);
  assert.equal(merged.fbaWeight, 0.15);
  assert.deepEqual(merged.suppliers, base.suppliers);
  assert.equal(merged.purchaseCost, 25);
  const manual = { ...base, manualWeight: true, productWeight: 0.6, productWeightEvidence: { source: 'manual' } };
  const protectedProduct = mergeAmazonCollectionProduct(manual, item);
  assert.equal(protectedProduct.productWeight, 0.6);
  assert.deepEqual(protectedProduct.productWeightEvidence, { source: 'manual' });
});
