import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAmazonCollectionProduct } from '../lib/amazon-collection-merge.mjs';

test('collection and old-evidence migration preserve manual date, status, evidence and source', () => {
  const asin = 'B09V6TRGTD';
  const evidence = { source: 'manual', value: '2020-01-01', note: 'User confirmed date' };
  for (const manual of [
    { manualAmazonFields: { amazonFirstAvailableDate: true } },
    { fieldSources: { amazonFirstAvailableDate: 'manual' } },
  ]) {
    const product = { id: `AU:${asin}`, asin, marketplace: 'AU',
      amazonFirstAvailableDate: '2020-01-01', amazonFirstAvailableDateStatus: 'found',
      amazonFirstAvailableDateEvidence: evidence, ...manual };
    for (const incoming of [
      { amazonFirstAvailableDate: null, amazonFirstAvailableDateStatus: 'unresolved', amazonFirstAvailableDateEvidence: null },
      { amazonFirstAvailableDate: '2022-02-02', amazonFirstAvailableDateStatus: 'found', amazonFirstAvailableDateEvidence: { source: 'amazon_product_information' } },
    ]) {
      const merged = mergeAmazonCollectionProduct(product, { asin, marketplace: 'AU', detailStatus: 'success', ...incoming });
      for (const key of ['amazonFirstAvailableDate', 'amazonFirstAvailableDateStatus', 'amazonFirstAvailableDateEvidence', 'manualAmazonFields']) assert.deepEqual(merged[key], product[key], key);
      assert.equal(merged.fieldSources.amazonFirstAvailableDate, product.fieldSources?.amazonFirstAvailableDate);
    }
  }
});
