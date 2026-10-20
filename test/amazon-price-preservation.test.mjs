import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAmazonCollectionProduct } from '../lib/amazon-collection-merge.mjs';
import { mergeAmazonPriceState } from '../lib/amazon-price-state.mjs';
import { auditAmazonProductFields } from '../lib/amazon-detail-quality.mjs';

const asin = 'B0H6VX4P3N';
const verifiedAt = '2026-10-20T01:31:27.910Z';
const checkedAt = '2026-10-20T01:42:44.208Z';
const evidence = { asin, observedAsin: 'B0HHRYYTP2', currency: 'CAD', source: 'visible_main_price',
  selector: '#corePriceDisplay_desktop_feature_div .priceToPay', rawText: '$14.99' };
const saved = () => ({ asin, sourceAsin: asin, marketplace: 'CA', currency: 'CAD', analysisSourceMode: 'amazon_only',
  detailStatus: 'success', detailParserVersion: 12, currentPrice: 14.99, salePrice: 14.99,
  priceEvidence: structuredClone(evidence), collectedAt: verifiedAt, currentPriceStatus: 'verified',
  fieldSources: { currentPrice: 'amazon_product_page' }, manualPurchaseCost: true, purchaseCost: 7,
  suppliers: [{ price: 4 }], reviewStatus: 'approved',
  priceRevalidation: { status: 'completed', requiredParserVersion: 5, verifiedParserVersion: 12 } });
const missing = (reason = 'price_requires_cart') => ({ asin, marketplace: 'CA', currentPrice: null,
  detailStatus: 'success', detailParserVersion: 12, priceEvidence: null, collectedAt: checkedAt,
  pageContextEvidence: { priceUnavailableReason: reason, regionStatus: 'unconfirmed' } });

for (const [name, merge] of [
  ['collection', mergeAmazonCollectionProduct],
  ['client', (old, item) => { const next = structuredClone(old); mergeAmazonPriceState(next, item); return next; }],
]) {
  for (const reason of ['price_requires_cart', 'delivery_region_unconfirmed']) test(`${name}: ${reason} retains observed price and original timestamp across repeated refreshes`, () => {
    const original = saved();
    const pending = merge(original, missing(reason));
    assert.equal(pending.currentPrice, 14.99);
    assert.equal(pending.currentPriceStatus, 'pending_revalidation');
    assert.equal(pending.priceVerifiedAt, verifiedAt);
    assert.equal(pending.priceRefresh.checkedAt, checkedAt);
    assert.equal(pending.reviewStatus, 'pending');
    assert.equal(pending.priceRevalidation.status, 'completed');
    const discovery = structuredClone(pending);
    mergeAmazonPriceState(discovery, { asin, detailStatus: 'pending', currentPrice: null, detailParserVersion: 0 });
    assert.equal(discovery.currentPrice, 14.99, 'a discovery-only record must not undo retained evidence');
    assert.equal(auditAmazonProductFields(pending).fields.price.status, 'missing');
    assert.equal(pending.purchaseCost, original.purchaseCost);
    assert.deepEqual(pending.suppliers, original.suppliers);
    const again = merge(pending, { ...missing(reason), collectedAt: '2026-10-20T02:00:00Z' });
    assert.equal(again.priceVerifiedAt, verifiedAt);
    assert.equal(original.currentPriceStatus, 'verified');
  });

  test(`${name}: historical erased price recovers only with matching evidence, without changing manual sale price`, () => {
    const old = { ...saved(), currentPrice: null, priceEvidence: null, currentPriceStatus: 'unavailable',
      collectedAt: checkedAt, manualSalePrice: true, salePrice: 19,
      lastKnownAmazonPrice: { currentPrice: 14.99, priceEvidence: evidence, collectedAt: verifiedAt } };
    const recovered = merge(old, missing());
    assert.equal(recovered.currentPrice, 14.99);
    assert.equal(recovered.priceVerifiedAt, verifiedAt);
    assert.equal(recovered.salePrice, 19);
    for (const bad of [{ ...evidence, asin: 'B000000001' }, { ...evidence, currency: 'USD' }, { ...evidence, source: 'recommendation' }]) {
      assert.equal(merge({ ...old, lastKnownAmazonPrice: { ...old.lastKnownAmazonPrice, priceEvidence: bad } }, missing()).currentPrice, null);
    }
    assert.equal(merge({ ...old, detailParserVersion: 4 }, missing()).currentPrice, null);
    assert.equal(merge({ ...old, lastKnownAmazonPrice: null }, missing()).currentPrice, null);
  });

  for (const reason of ['unavailable', 'page_not_provided']) test(`${name}: confirmed ${reason} clears price and cannot be revived by a subsequent cart gate`, () => {
    const absent = merge(saved(), missing(reason));
    assert.equal(absent.currentPrice, null);
    assert.equal(absent.currentPriceStatus, 'unavailable');
    assert.equal(merge(absent, missing()).currentPrice, null);
  });

  test(`${name}: manual prices survive and fresh successful quotes clear the pending status`, () => {
    const manual = { ...saved(), manualAmazonFields: { currentPrice: true }, currentPrice: 20 };
    assert.equal(merge(manual, missing()).currentPrice, 20);
    const pending = merge(saved(), missing());
    const fresh = merge(pending, { ...missing(), currentPrice: 15.99, priceEvidence: { ...evidence, rawText: '$15.99' }, pageContextEvidence: {} });
    assert.equal(fresh.currentPrice, 15.99);
    assert.equal(fresh.currentPriceStatus, 'verified');
    assert.equal(fresh.priceRefresh, undefined);
    assert.equal(fresh.priceVerifiedAt, checkedAt);
  });
}
