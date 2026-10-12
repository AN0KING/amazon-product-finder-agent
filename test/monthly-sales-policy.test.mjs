import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlySalesValue, monthlySalesEvidence, hasQualifyingMonthlySales, summarizeMonthlySalesCoverage } from '../lib/monthly-sales-policy.mjs';

const asin = 'B012345678';
const amazonEvidence = (value = 50) => ({ asin, source: 'amazon_product_page', period: 'past_month', kind: 'lower_bound', value, rawText: `${value}+ bought in past month` });
const apiProduct = (extra = {}, evidence = {}) => ({ asin, sourceAsin: asin, marketplace: 'US', sourceMarketplace: 'US',
  analysisSourceMode: 'amazon_sellsprite', sales30: 120, detailStatus: 'success',
  sales30Evidence: { source: 'sellsprite_api', sourceTool: 'competitor_lookup', field: 'amzUnit', kind: 'estimate',
    period: 'past_month', scope: 'asin', asin, marketplace: 'US', providerMarketplace: 'US', value: 120,
    updatedAt: null, ...evidence }, ...extra });

test('enabled API monthly estimates qualify for the identical source ASIN and market', () => {
  assert.equal(monthlySalesValue(apiProduct()), 120);
  assert.equal(hasQualifyingMonthlySales(apiProduct()), true);
  assert.equal(monthlySalesValue(apiProduct({ analysisSourceMode: 'amazon_only' })), null);
  assert.equal(monthlySalesValue(apiProduct({ analysisSourceMode: 'amazon_only' }), { useSellerSprite: true }), 120);
  assert.equal(monthlySalesValue(apiProduct(), { useSellerSprite: false }), null);
  assert.equal(monthlySalesValue(apiProduct({ sales30: 0 }, { value: 0 })), 0);
  assert.equal(hasQualifyingMonthlySales(apiProduct({ sales30: 49 }, { value: 49 })), false);

});

test('parent totals, other ASINs, proxy markets, unsupported periods and isolated numbers cannot qualify', () => {
  for (const evidence of [
    { asin: 'B098765432' }, { asin: '' }, { marketplace: 'AU' }, { providerMarketplace: 'AU' },
    { marketplace: null }, { providerMarketplace: null }, { sourceTool: 'arbitrary' }, { sourceTool: 'asin_detail' }, { source: 'manual' },
    { field: 'units' }, { field: 'sales30' }, { field: 'units30' }, { kind: 'reported_count' }, { scope: 'parent' }, { period: 'past_year' }, { kind: 'lower_bound' },
    { value: 121 }, { value: '120' }, { value: -1 }, { value: 1.5 }, { value: Infinity },
  ]) assert.equal(monthlySalesValue(apiProduct({}, evidence)), null, JSON.stringify(evidence));
  assert.equal(monthlySalesValue(apiProduct({ sales30Evidence: null })), null);
  assert.equal(monthlySalesValue(apiProduct({ marketplace: 'AU', sourceMarketplace: 'AU' })), null);
  assert.equal(monthlySalesValue(apiProduct({ marketplace: 'AU' })), null, 'Contradictory product marketplace cannot qualify');
  assert.equal(monthlySalesValue(apiProduct({ providerMarketplace: 'AU' })), null, 'Proxy marketplace metadata cannot qualify');
  assert.equal(monthlySalesValue(apiProduct({ sourceAsin: 'B098765432', parentAsin: asin })), null);
  assert.equal(monthlySalesValue(apiProduct({ asin: 'B098765432', parentAsin: 'B098765432' })), 120, 'Original source ASIN remains the exact query identity');
});

test('source-off fallback keeps original Amazon evidence without borrowing API or manual numbers', () => {
  const candidate = apiProduct({ amazonSales30Evidence: amazonEvidence(50) });
  const before = structuredClone(candidate);
  assert.equal(monthlySalesValue(candidate), 120);
  assert.equal(monthlySalesValue(candidate, { useSellerSprite: false }), 50);
  assert.equal(monthlySalesEvidence(candidate, { useSellerSprite: false }).source, 'amazon_product_page');
  assert.equal(monthlySalesValue(apiProduct({ amazonSales30Evidence: { ...amazonEvidence(), asin: 'B098765432' } }), { useSellerSprite: false }), null);
  for (const extra of [{ manualAmazonFields: { sales30: true } }, { manualAmazonOverride: true }, { fieldSources: { sales30: 'manual' } }]) {
    assert.equal(monthlySalesValue({ ...candidate, ...extra }), null);
    assert.equal(monthlySalesValue({ ...candidate, ...extra }, { useSellerSprite: false }), null);
  }
  assert.deepEqual(candidate, before);
});

test('coverage distinguishes known-low sales from absent, pending and failed observations', () => {
  const rows = [
    apiProduct(), apiProduct({ sales30: 20 }, { value: 20 }),
    { asin, sales30: 50, sales30Evidence: amazonEvidence() },
    { detailStatus: 'pending', sales30: null },
    { detailStatus: 'failed', collectionQuality: { fields: { sales30: { status: 'missing', reason: 'request_failed' } } } },
    { detailStatus: 'success', collectionQuality: { fields: { sales30: { status: 'unavailable' } } } },
    { detailStatus: 'success', sales30: 999 },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(summarizeMonthlySalesCoverage(rows), { total: 7, verified: 3, qualified: 2, belowThreshold: 1,
    unknown: 4, pending: 1, failed: 1, pageUnavailable: 1, unverified: 1, bySource: { amazon: 1, sellerSprite: 2 } });
  const disabled = summarizeMonthlySalesCoverage(rows, { useSellerSprite: false });
  assert.equal(disabled.qualified, 1);
  assert.equal(disabled.unknown, 6);
  assert.equal(disabled.unverified, 3);
  assert.deepEqual(rows, before);
});


test('editing costs, weight or price does not invalidate unchanged automated monthly sales', () => {
  for (const candidate of [
    { asin, sales30: 50, sales30Evidence: amazonEvidence() },
    apiProduct({ amazonSales30Evidence: amazonEvidence() }),
  ]) {
    for (const mask of [{ sales30: false, currentPrice: true }, { title: true }, {}]) {
      const edited = { ...candidate, manualAmazonOverride: true, manualAmazonFields: mask,
        manualPurchaseCost: true, purchaseCost: 20, manualWeight: true, productWeight: 0.1 };
      const before = structuredClone(edited);
      assert.equal(hasQualifyingMonthlySales(edited), true);
      assert.equal(monthlySalesValue(edited, { useSellerSprite: false }), 50);
      assert.deepEqual(edited, before, 'Parsing must not rewrite the saved manual flags or evidence');
      assert.equal(monthlySalesValue({ ...edited, manualAmazonFields: { ...mask, sales30: true } }), null);
    }
    for (const invalidMask of [undefined, null, true, []]) {
      assert.equal(monthlySalesValue({ ...candidate, manualAmazonOverride: true, manualAmazonFields: invalidMask }), null,
        'Legacy global override without a field mask remains untrusted');
    }
  }
});

test('the displayed current sales value must agree with its evidence, while the saved Amazon fallback keeps its own value', () => {
  assert.equal(monthlySalesValue({ asin, sales30: 99, sales30Evidence: amazonEvidence(50) }), null);
  assert.equal(monthlySalesValue({ asin, sales30: null, sales30Evidence: amazonEvidence(50) }), null);
  const candidate = apiProduct({ amazonSales30Evidence: amazonEvidence(50), manualAmazonOverride: true, manualAmazonFields: { sales30: false } });
  assert.equal(monthlySalesValue(candidate), 120);
  assert.equal(monthlySalesValue(candidate, { useSellerSprite: false }), 50);
});


test('sales API failures count only for the enabled source when no valid observation can be used', () => {
  const rows = ['failed', 'invalid'].map(competitorLookupStatus => apiProduct({ sales30: null, sales30Evidence: null,
    competitorLookupStatus, detailStatus: 'success' }));
  rows.push(apiProduct({ sales30: null, sales30Evidence: null, competitorLookupStatus: 'failed',
    amazonSales30Evidence: amazonEvidence(50) }));
  const before = structuredClone(rows);
  const enabled = summarizeMonthlySalesCoverage(rows, { useSellerSprite: true });
  assert.equal(enabled.failed, 2);
  assert.equal(enabled.unknown, 2);
  assert.equal(enabled.qualified, 1, 'A valid Amazon fallback remains usable despite the sales API failure');
  assert.equal(enabled.bySource.amazon, 1);
  const disabled = summarizeMonthlySalesCoverage(rows, { useSellerSprite: false });
  assert.equal(disabled.failed, 0, 'A disabled source must not label Amazon collection as failed');
  assert.equal(disabled.unknown, 2);
  assert.equal(disabled.unverified, 2);
  assert.equal(disabled.qualified, 1);
  assert.equal(summarizeMonthlySalesCoverage(rows).failed, 2, 'Default mode follows the product source');
  assert.deepEqual(rows, before);
});


test('queued Amazon placeholders with stale failure audits are pending, while actual failures remain failed', () => {
  const pending = () => ({ analysisSourceMode: 'amazon_only', detailStatus: 'pending', detailErrorCode: 'AMAZON_DETAIL_PENDING',
    sales30: null, sales30Evidence: null,
    collectionQuality: { fields: { sales30: { status: 'missing', reason: 'request_failed', errorCode: 'AMAZON_DETAIL_PENDING' } } } });
  const failed = () => ({ ...pending(), detailStatus: 'failed', detailErrorCode: 'AMAZON_REQUEST_FAILED' });
  const rows = [...Array.from({ length: 74 }, pending), ...Array.from({ length: 6 }, failed)];
  const before = structuredClone(rows);
  const result = summarizeMonthlySalesCoverage(rows, { useSellerSprite: false });
  assert.equal(result.total, 80);
  assert.equal(result.unknown, 80);
  assert.equal(result.pending, 74);
  assert.equal(result.failed, 6);
  assert.equal(result.unverified, 0);
  assert.deepEqual(rows, before);
});

test('explicit in-progress states precede old sales failures without hiding a settled API failure', () => {
  for (const detailStatus of ['pending', 'loading', 'running', 'retrying', 'queued']) {
    const candidate = apiProduct({ detailStatus, sales30: null, sales30Evidence: null, competitorLookupStatus: 'failed',
      collectionQuality: { fields: { sales30: { status: 'missing', reason: 'request_failed' } } } });
    const result = summarizeMonthlySalesCoverage([candidate]);
    assert.equal(result.pending, 1, detailStatus);
    assert.equal(result.failed, 0, detailStatus);
  }
  const settled = apiProduct({ detailStatus: 'success', sales30: null, sales30Evidence: null, competitorLookupStatus: 'failed',
    collectionQuality: { fields: { sales30: { status: 'missing', reason: 'not_collected' } } } });
  assert.equal(summarizeMonthlySalesCoverage([settled]).failed, 1, 'A real enabled API failure wins over a generic not-collected audit');
  assert.equal(summarizeMonthlySalesCoverage([settled], { useSellerSprite: false }).pending, 1, 'A disabled API error does not affect Amazon status');
});
