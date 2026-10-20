import test from 'node:test';
import assert from 'node:assert/strict';
import { createAmazonSearchSession } from '../lib/amazon-store-client.mjs';
import { AMAZON_SEARCH_POLICY } from '../lib/amazon-search-v0950.mjs';
import { amazonCollectionRecoveryReason } from '../lib/amazon-detail-retry.mjs';

const asin = 'B0FWRPKFQD';
const page = (rows = '', price = '$9.99') => `<html><title>Product</title><body>
  <input id="ASIN" value="${asin}"><h1 id="productTitle">Test product</h1>
  <div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">${price}</span></span></div>
  <table id="productDetails_techSpec_section_1">${rows}</table></body></html>`;
const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;

async function sessionFor(t, market, body) {
  const origin = market === 'AU' ? 'https://www.amazon.com.au' : 'https://www.amazon.ca';
  const url = `${origin}/test-product/dp/${asin}/ref=test?th=1`;
  let visits = 0;
  const session = await createAmazonSearchSession(market, {
    edgeExecutable: 'C:/mock/msedge.exe', requestIntervalMs: 0,
    executeFetch: async (value) => {
      const requested = new URL(value);
      if (requested.pathname === '/') return new Response('<html>Amazon</html>');
      if (requested.pathname.includes('address-change')) return new Response(JSON.stringify({
        isValidAddress: true, isAddressUpdated: true, successful: true,
        address: { zipCode: market === 'AU' ? '3010' : 'M5V 2T6', countryCode: market },
      }));
      assert.equal(requested.href, url);
      visits++;
      return new Response(body);
    },
    executeRequest: async () => { throw new Error('Unexpected curl'); },
    executeBrowser: async () => { throw new Error('Unexpected browser'); },
  });
  t.after(() => session.close());
  return { session, url, visits: () => visits };
}

for (const [market, raw, kg] of [['AU', '110 g', 0.11], ['CA', '30 g', 0.03], ['CA', '0.37 pounds', 0.167829]]) {
  test(`restored ${market} visit retains Item Weight ${raw} without mandatory date inspection`, async t => {
    const f = await sessionFor(t, market, page(row('Item Weight', raw)));
    let browser = 0;
    f.session.fetchProductDetailWithEdgeCdp = async () => { browser++; throw new Error('Missing date must not visit Edge'); };
    const result = await f.session.getProductDetail(asin, { productUrl: f.url });
    assert.equal(result.productWeightKg, kg);
    assert.equal(result.productWeightEvidence.rawText, raw);
    assert.equal(result.productWeightEvidence.label, 'item weight');
    assert.equal(result.productInformation.collectionStrategy, AMAZON_SEARCH_POLICY);
    assert.equal(result.amazonFirstAvailableDateStatus, 'unresolved');
    assert.equal(result.currentPrice, 9.99);
    assert.equal(f.visits(), 1);
    assert.equal(browser, 0);
  });
}

test('restoration excludes dimension, package and load weights and preserves unverified status', async t => {
  const f = await sessionFor(t, 'CA', page(row('Product Dimensions', '10 x 5 x 3 cm; 100 g')
    + row('Package Weight', '200 g') + row('Maximum Weight Capacity', '5 kg')));
  const result = await f.session.getProductDetail(asin, { productUrl: f.url });
  assert.equal(result.productWeightKg, null);
  assert.equal(result.productInformation.weightStatus, 'unresolved');
  assert.equal(f.visits(), 1);
});

test('restored browser fallback reads the page once without full specifications traversal', async t => {
  const f = await sessionFor(t, 'CA', page());
  let reads = 0;
  f.session.deliveryRegionReady.add('edge_cdp');
  f.session.ensureEdgeCdpSession = async () => ({
    navigateUntilSettled: async url => ({ url }),
    pageHtml: async () => { reads++; return page(row('Item Weight', '30 g')); },
    inspectProductInformation: async () => { throw new Error('Unexpected specification traversal'); },
  });
  const result = await f.session.fetchProductDetailWithEdgeCdp(f.url, asin);
  assert.equal(result.productWeightKg, 0.03);
  assert.equal(reads, 1);
});

test('cart fallback timeout preserves HTTP evidence, actual verification pauses', async t => {
  const f = await sessionFor(t, 'CA', page(row('Item Weight', '30 g')));
  const original = await f.session.getProductDetail(asin, { productUrl: f.url });
  const detail = { ...original, currentPrice: null, pageContextEvidence: { priceUnavailableReason: 'price_requires_cart' } };
  f.session.fetchProductDetailWithEdgeCdp = async () => { throw Object.assign(new Error('loading'), { code: 'EDGE_CDP_NAVIGATION_TIMEOUT' }); };
  const supplemented = await f.session.supplementProductDetail(detail, f.url, asin);
  assert.deepEqual(supplemented, { ...detail, priceReadAttempt: { status: 'failed', code: 'EDGE_CDP_NAVIGATION_TIMEOUT', message: 'loading' } });
  f.session.fetchProductDetailWithEdgeCdp = async () => { throw Object.assign(new Error('captcha_form'), { code: 'EDGE_CDP_CHALLENGE_TIMEOUT' }); };
  await assert.rejects(f.session.supplementProductDetail(detail, f.url, asin), { code: 'AMAZON_ACCESS_CHALLENGE' });
});

test('restored successful weight does not schedule repeated visits just for missing date', () => {
  const item = { asin, detailStatus: 'success', amazonFirstAvailableDateStatus: 'unresolved',
    productInformation: { asin, collectionStrategy: AMAZON_SEARCH_POLICY, weightStatus: 'found' },
    collectionQuality: { fields: { weight: { status: 'verified' } } } };
  assert.equal(amazonCollectionRecoveryReason(item), null);
  item.collectionQuality.fields.weight.status = 'missing';
  item.productInformation.weightStatus = 'unresolved';
  assert.equal(amazonCollectionRecoveryReason(item).reasonCode, 'AMAZON_PRODUCT_INFORMATION_INCOMPLETE');
});
