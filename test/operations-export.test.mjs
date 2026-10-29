import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { load } from 'cheerio';
import { OPERATIONS_MISSING as missing, normalizeSupplierChoiceUrl, chosenSupplierUrl,
  operationsColumnHeaders, operationsColumnValues } from '../lib/operations-export.mjs';
import { createEmbeddedImageWorkbook } from '../lib/xlsx-export.mjs';

const selectedUrl = 'https://detail.1688.com/offer/100000001.html';
const manualUrl = 'https://detail.1688.com/offer/100000002.html';

test('manual supplier choice wins, clearing restores radio, and invalid manual never silently chooses another factory', () => {
  assert.equal(chosenSupplierUrl({ supplierChoice: { selectedUrl, manualUrl } }), manualUrl);
  assert.equal(chosenSupplierUrl({ supplierChoice: { selectedUrl, manualUrl: '  ' } }), selectedUrl);
  assert.equal(chosenSupplierUrl({ supplierChoice: { selectedUrl, manualUrl: 'bad link' } }), '');
  for (const value of ['javascript:alert(1)', 'https://1688.com.evil.example/x', 'https://evil1688.com/x',
    'https://user:pass@detail.1688.com/x', 'https://1688.com:9999/x', '', null]) assert.equal(normalizeSupplierChoiceUrl(value), '');
  assert.equal(normalizeSupplierChoiceUrl(` ${manualUrl} `), manualUrl);
});

test('operations fields copy saved amounts verbatim with zero, negative profit and real weight in grams', () => {
  const product = { sourceAsin: 'B000000001', sales30: 100, salePrice: 40, purchaseCost: 60, fbaFee: 7,
    fulfillmentMode: 'FBA', supplierChoice: { selectedUrl, manualUrl },
    profitInputs: { commissionRate: 99, marketingRate: 99, returnsRate: 99 },
    profitCalculation: { domesticFreightCny: 4, totalCost: 41, profit: -1, margin: -2.5,
      parts: { purchase: 14, commission: 5.4, freight: 2.3, fxLoss: 0.54, marketing: 3.6,
        management: 0, returns: 1.44 } } };
  const before = structuredClone(product);
  assert.deepEqual(operationsColumnValues(product, { amazonUrl: 'https://www.amazon.ca/dp/B000000001', weightKg: 0.203 }),
    [manualUrl, 'https://www.amazon.ca/dp/B000000001', 'B000000001', 100, 40, 60, 4, 14, 5.4, 7,
      203, 2.3, 0.54, 3.6, 0, 1.44, missing, 41, -1, -2.5]);
  assert.deepEqual(product, before);
});

test('missing amounts are explicit, never inferred from rates or dimensional weight', () => {
  assert.deepEqual(operationsColumnValues({ profitInputs: { commissionRate: 15 }, dimensionalWeightKg: 2 }), Array(20).fill(missing));
  const row = operationsColumnValues({ fulfillmentMode: 'FBM', fbaFee: 5, vat: 0,
    profitCalculation: { management: 0, fxLoss: NaN, totalCost: Infinity } });
  assert.equal(row[9], missing); assert.equal(row[10], missing); assert.equal(row[12], missing);
  assert.equal(row[14], 0); assert.equal(row[16], 0); assert.equal(row[17], missing);
});

test('actual workbook retains numeric results, literal missing text and both clickable links without formulas', async () => {
  const amazonUrl = 'https://www.amazon.ca/dp/B000000001';
  const headers = ['图片', ...operationsColumnHeaders('CAD')];
  const values = operationsColumnValues({ supplierChoice: { selectedUrl, manualUrl },
    sourceAsin: 'B000000001', sales30: 100, salePrice: 40, fulfillmentMode: 'FBA',
    profitCalculation: { management: 0, margin: 17.25 } }, { amazonUrl, weightKg: 0.203 });
  const { buffer } = await createEmbeddedImageWorkbook({ worksheetName: '运营确认表', headers,
    rows: [['', ...values]], images: [null], imageColumnIndex: 0, layout: 'reviewed-products-v1',
    fetchImpl: async () => { throw new Error('No external request expected'); } });
  const files = unzipSync(buffer);
  const sheet = load(strFromU8(files['xl/worksheets/sheet1.xml']), { xmlMode: true });
  const links = strFromU8(files['xl/worksheets/_rels/sheet1.xml.rels']);
  assert.match(links, /100000002\.html/); assert.ok(links.includes(amazonUrl)); assert.ok(!links.includes(selectedUrl));
  assert.equal(sheet('f').length, 0);
  assert.equal(sheet('c[r="F2"] v').text(), '40'); assert.equal(sheet('c[r="F2"]').attr('t'), undefined);
  assert.equal(sheet('c[r="L2"] v').text(), '203'); assert.equal(sheet('c[r="P2"] v').text(), '0');
  assert.equal(sheet('c[r="R2"] t').text(), missing); assert.equal(sheet('c[r="U2"] v').text(), '17.25');
  assert.equal(sheet('row[r="1"]').attr('ht'), '48');
  assert.equal(sheet('autoFilter').attr('ref'), 'A1:U2');
});
