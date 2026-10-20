import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAnalysisCoverage } from '../lib/analysis-coverage.mjs';

const A = 'B09V6TRGTD', B = 'B000000002';
const stores = [{ inputMode: 'asins', marketplace: 'CA', sellerId: null, asins: [A, B] }];
test('ASIN-only coverage never invents requested or unvisited shops', () => {
  const empty = summarizeAnalysisCoverage({ stores, marketplace: 'CA' });
  assert.equal(empty.scope, 'amazon_imported_asins');
  assert.equal(empty.status, 'not_started');
  assert.equal(empty.counts.requested_stores, 0);
  assert.equal(empty.counts.unvisited_stores, 0);
  assert.equal(empty.direct_asins.requested, 2);
  assert.equal(empty.direct_asins.missing, 2);
  assert.deepEqual(empty.stores, []);
});
test('ASIN-only coverage requires every imported marketplace identity to be successfully visited', () => {
  const products = [
    { asin: A, marketplace: 'CA', detailStatus: 'success' },
    { asin: A, marketplace: 'CA', detailStatus: 'success' },
    { asin: B, marketplace: 'AU', detailStatus: 'success' },
  ];
  const partial = summarizeAnalysisCoverage({ stores, products, marketplace: 'CA' });
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.direct_asins, { requested: 2, observed: 1, missing: 1, successful: 1, complete: false });
  products.push({ asin: B, marketplace: 'CA', detailStatus: 'success' });
  const complete = summarizeAnalysisCoverage({ stores, products, marketplace: 'CA' });
  assert.equal(complete.direct_asins.complete, true);
  assert.equal(complete.status, 'visible_scope_complete');
  assert.equal(complete.full_store_complete, false);
});
test('store imports retain their catalog scope even if they include prefetched ASINs', () => {
  const coverage = summarizeAnalysisCoverage({ stores: [{ marketplace: 'CA', sellerId: 'SELLER01', asins: [A] }] });
  assert.equal(coverage.scope, 'amazon_visible_store_results');
  assert.equal(coverage.counts.requested_stores, 1);
});
