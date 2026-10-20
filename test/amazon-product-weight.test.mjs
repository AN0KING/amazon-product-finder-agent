import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseAmazonProductPage } from '../lib/amazon-store-client.mjs';

const asin = 'B0A0000001';
const parse = body => parseAmazonProductPage('<input id="ASIN" value="' + asin + '"><h1 id="productTitle">Sample</h1>' + body, { marketplace: 'AU', asin });
const table = rows => '<table>' + rows.map(([label, value]) => '<tr><th>' + label + '</th><td>' + value + '</td></tr>').join('') + '</table>';
const details = rows => '<div id="productDetails_feature_div">' + table(rows) + '</div>';
const panel = (heading, rows) => '<div class="a-expander-container"><a class="a-expander-header" aria-expanded="false">' + heading + '</a><div class="a-expander-content" style="display:none">' + table(rows) + '</div></div>';

test('captured CREST collapsed information retains Item Weight and all specification sections', () => {
  const source = readFileSync(new URL('./fixtures/amazon-b08pszmzrq-product-information.html', import.meta.url), 'utf8');
  const result = parseAmazonProductPage(source, { marketplace: 'AU', asin: 'B08PSZMZRQ' });
  assert.equal(result.productWeightKg, 0.02);
  assert.equal(result.productWeightEvidence.rawText, '0.02 Kilograms');
  assert.equal(result.productWeightEvidence.label, 'item weight');
  assert.equal(result.productInformation.rowCount, 23);
  assert.equal(result.productInformation.sections.length, 4);
  assert.equal(result.productInformation.weightSelection.policy, 'item_weight_only');
});

test('captured laundry-bag Measurements reads 170g and keeps 4.54kg load capacity out of weight', () => {
  const source = readFileSync(new URL('./fixtures/amazon-b08ywzc4c6-product-information.html', import.meta.url), 'utf8');
  const result = parseAmazonProductPage(source, { marketplace: 'AU', asin: 'B08YWZC4C6' });
  assert.equal(result.productWeightKg, 0.17);
  assert.equal(result.productWeightEvidence.rawText, '170 Grams');
  assert.equal(result.productWeightEvidence.asin, 'B08YWZC4C6');
  assert.equal(result.productInformation.weightStatus, 'found');
});

for (const label of ['Product Weight', 'Net Weight', 'Weight', 'Package Weight', 'Shipping Weight', 'Gross Weight', 'Item Display Weight', 'Load Capacity', 'Maximum Weight', 'Product Dimensions', 'Package Dimensions']) {
  test(label + ' cannot substitute for Item Weight', () => {
    const result = parse(details([[label, '150 g']]));
    assert.equal(result.productWeightKg, null);
    assert.equal(result.productWeightEvidence, null);
    assert.equal(result.productInformation.weightSelection.selected, null);
    assert.notEqual(result.productInformation.weightStatus, 'found');
  });
}

test('Item Weight normalizes formatting and units without mixing unrelated labels', () => {
  for (const [text, expected] of [['170 Grams', .17], ['0.37 Pounds', .167829], ['2 ounces', .056699], ['0.02 Kilograms', .02]]) {
    const result = parse(details([['Item\u200e Weight :', text], ['Net Weight', '900 g'], ['Item Display Weight', '3 kg'], ['Package Weight', '4 kg']]));
    assert.equal(result.productWeightKg, expected);
    assert.equal(result.productWeightEvidence.label, 'item weight');
    assert.equal(result.productWeightEvidence.rawText, text);
    assert.equal(result.productInformation.weightConflicts, undefined);
  }
});

test('native Measurements and technical Item Weight take priority over old bullets and other structured rows', () => {
  const old = '<div id="detailBullets_feature_div"><ul><li><b>Item Weight:</b> 0.37 Pounds</li></ul></div>';
  const main = '<div id="productDetails_feature_div">' + panel('Item details', [['Item Weight', '200 g']]) + panel('Measurements', [['Item Weight', '170 Grams']]) + '</div>';
  const result = parse(old + main);
  assert.equal(result.productWeightKg, .17);
  assert.equal(result.productWeightEvidence.rawText, '170 Grams');
  assert.equal(result.productInformation.weightSelection.alternatives.length, 2);
  assert.ok(result.productInformation.weightSelection.alternatives.some(reading => reading.rawText === '0.37 Pounds'));
  assert.equal(result.productInformation.reason, null);
  const technical = parse(old + '<table id="productDetails_techSpec_section_1"><tr><th>Item Weight</th><td>140 g</td></tr></table>');
  assert.equal(technical.productWeightKg, .14);
});

test('different Item Weight readings retain one prioritized reading and diagnostics instead of rejecting the product', () => {
  for (const values of [['20 g', '30 g'], ['170 g', '0.3700 pounds'], ['1 kg', '2.3 lb']]) {
    const result = parse(details(values.map(value => ['Item Weight', value])));
    assert.ok(result.productWeightKg > 0);
    assert.equal(result.productWeightEvidence.rawText, values[0]);
    assert.equal(result.productInformation.status, 'complete');
    assert.equal(result.productInformation.reason, null);
    assert.equal(result.productInformation.weightConflicts, undefined);
    assert.equal(result.productInformation.weightSelection.alternatives[0].rawText, values[1]);
  }
  const combined = parse(details([['Item Weight', '20 g (0.02 kg)']]));
  assert.equal(combined.productWeightKg, .02);
  assert.equal(combined.productInformation.weightSelection.alternatives.length, 1);
});

test('page, canonical, nested-owner and specification ASIN differences are diagnostics, preserving task ASIN', () => {
  const other = 'B0A0000009';
  const result = parseAmazonProductPage('<input id="ASIN" value="' + other + '"><link rel="canonical" href="https://www.amazon.com.au/dp/' + other + '"><h1 id="productTitle">Sample</h1>'
    + details([['ASIN', other], ['Item Weight', '<span data-asin="' + other + '">140 g</span>'], ['Date First Available', '21 December 2021']]), { marketplace: 'AU', asin });
  assert.equal(result.asin, asin);
  assert.equal(result.productWeightKg, .14);
  assert.equal(result.productWeightEvidence.asin, asin);
  assert.equal(result.amazonFirstAvailableDate, '2021-12-21');
  assert.equal(result.productInformation.identityDiagnostics.pageAsin, other);
  assert.deepEqual(result.productInformation.identityDiagnostics.specificationAsins, [other]);
  assert.equal(result.productInformation.discardedSections, undefined);
});

test('captured mixed-ASIN Voyager page keeps its displayed date without refusing the source product', () => {
  const source = readFileSync(new URL('./fixtures/amazon-b09nxs1bll-mixed-identity.html', import.meta.url), 'utf8');
  const result = parseAmazonProductPage(source, { marketplace: 'AU', asin: 'B09NXS1BLL' });
  assert.equal(result.asin, 'B09NXS1BLL');
  assert.equal(result.amazonFirstAvailableDate, '2021-12-21');
  assert.ok(result.productInformation.identityDiagnostics.specificationAsins.includes('B09QHCKV68'));
  assert.ok(result.productInformation.identityDiagnostics.specificationAsins.includes('B09NXS1BLL'));
  assert.equal(result.productWeightKg, null);
  assert.equal(result.productInformation.discardedSections, undefined);
});

test('hidden, template, review and recommendation Item Weight rows remain excluded', () => {
  for (const wrapper of ['hidden', 'class="aok-hidden"', 'style="display:none"', 'id="recommendations"', 'class="product-template"', 'class="comparison-table"', 'data-component-type="sponsored-products"']) {
    assert.equal(parse('<div ' + wrapper + '>' + details([['Item Weight', '999 g']]) + '</div>').productWeightKg, null, wrapper);
  }
  for (const hidden of ['hidden', 'aria-hidden="true"', 'style="display:none"']) {
    assert.equal(parse('<div id="productDetails_feature_div"><table><tr><th>Item Weight</th><td ' + hidden + '>999 g</td></tr></table></div>').productWeightKg, null);
  }
  const folded = parse('<div id="productDetails_feature_div">' + panel('Measurements', [['Item Weight', '140 g']]) + '</div>');
  assert.equal(folded.productWeightKg, .14);
});

test('definition lists, table cells and labelled grids read only explicit Item Weight', () => {
  for (const body of [
    '<dl><dt>Item Weight</dt><dd>125 g</dd></dl>',
    '<div role="row"><span role="cell">Item Weight</span><span role="cell">125 g</span></div>',
    '<div class="a-row"><span class="a-text-bold">Item Weight</span><span>125 g</span></div>',
    '<div class="a-fixed-left-grid"><div class="a-fixed-left-grid-col">Item Weight</div><div class="a-fixed-left-grid-col">125 g</div></div>',
  ]) assert.equal(parse('<div id="itemDetails_feature_div">' + body + '</div>').productWeightKg, .125);
});

test('marketing prose and JSON-LD do not provide an Item Weight substitute', () => {
  for (const body of [
    '<div id="productDescription">Net Weight: 125 g; Item Weight: 130 g</div>',
    '<div id="productDescription"><table><tr><th>Net Weight</th><td>125 g</td></tr></table></div>',
    '<script type="application/ld+json">' + JSON.stringify({ '@type': 'Product', sku: asin, name: 'Sample', weight: '125 g' }) + '</script>',
    '<div id="feature-bullets"><ul><li>Maximum weight capacity 50 kg</li></ul></div>',
  ]) assert.equal(parse(body).productWeightKg, null);
});

test('an unavailable Item Weight stays unresolved and structural HTML alone never proves absence', () => {
  const invalid = parse(details([['Item Weight', 'not available']]));
  assert.equal(invalid.productWeightKg, null);
  assert.equal(invalid.productInformation.weightStatus, 'unresolved');
  const absent = parse(details([['Brand', 'Example'], ['Package Weight', '500 g']]));
  assert.equal(absent.productWeightKg, null);
  assert.equal(absent.packageWeightKg, .5);
  assert.equal(absent.productInformation.weightStatus, 'unresolved');
  const bounded = parse(details(Array.from({length: 301}, (_, index) => ['Field ' + index, 'Value'])));
  assert.equal(bounded.productInformation.status, 'incomplete');
});
