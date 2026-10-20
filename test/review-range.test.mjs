import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewRange, reviewRangeExclusionReasons, intersectReviewRanges } from '../lib/review-range.mjs';
import { parseStoreRows } from '../lib/store-list.mjs';
import { evaluateAnalysisProduct } from '../lib/analysis-handoff.mjs';
import { DEFAULT_PROFIT_RATES } from '../lib/profit-model.mjs';

test('review bounds are inclusive, optional and distinguish zero from unknown', () => {
  assert.deepEqual(normalizeReviewRange({}), { minReviews: null, maxReviews: null });
  assert.deepEqual(normalizeReviewRange({ minReviews: ' ', maxReviews: '０' }), { minReviews: null, maxReviews: 0 });
  const criteria = { minReviews: 20, maxReviews: 100 };
  for (const value of [20, 50, 100]) assert.deepEqual(reviewRangeExclusionReasons(value, criteria), []);
  assert.deepEqual(reviewRangeExclusionReasons(19, criteria), ['REVIEWS_BELOW_MINIMUM']);
  assert.deepEqual(reviewRangeExclusionReasons(101, criteria), ['REVIEWS_ABOVE_MAXIMUM']);
  assert.deepEqual(reviewRangeExclusionReasons(0, { maxReviews: 0 }), []);
  for (const value of [null, undefined, '', ' ', false, -1, 1.5, Infinity]) {
    assert.deepEqual(reviewRangeExclusionReasons(value, { maxReviews: 0 }), ['REVIEWS_MISSING']);
    assert.deepEqual(reviewRangeExclusionReasons(value, {}), []);
  }
});

test('invalid bounds fail before collection or export', () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, false, [], {}, '-1', '1e3']) {
    for (const field of ['minReviews', 'maxReviews']) assert.throws(() => normalizeReviewRange({ [field]: value }), RangeError);
  }
  assert.throws(() => normalizeReviewRange({ minReviews: 101, maxReviews: 100 }), /不能大于/);
  assert.deepEqual(normalizeReviewRange({ minReviews: 100, maxReviews: 100 }), { minReviews: 100, maxReviews: 100 });
});

test('store spreadsheets preserve both bounds and reject reversed ranges', () => {
  const header = ['sellerId', '最小评价数', '最大评价数'];
  const result = parseStoreRows([header, ['A1EXAMPLE001', 20, 100]], { marketplace: 'AU' });
  assert.equal(result.stores[0].criteria.minReviews, 20);
  assert.equal(result.stores[0].criteria.maxReviews, 100);
  assert.equal(result.stores[0].criteriaSource.rows[0].rawCriteria.minReviews, 20);
  assert.equal(result.stores[0].criteriaSource.rows[0].rawCriteria.maxReviews, 100);
  const reversed = parseStoreRows([header, ['A1EXAMPLE001', 101, 100]], { marketplace: 'AU' });
  assert.equal(reversed.stores.length, 0);
  assert.ok(reversed.issues.some(issue => issue.code === 'INVALID_REVIEW_RANGE'));
});

function evaluate(reviews, criteria, extra = {}) {
  const asin = 'B09V6TRGTD';
  return evaluateAnalysisProduct({
    id: `AU:${asin}`, asin, marketplace: 'AU', name: 'Synthetic review-range product', detailStatus: 'success',
    reviews, sales30: 50, sales30Evidence: { asin, source: 'amazon_product_page', kind: 'lower_bound', period: 'past_month', value: 50, rawText: '50+ bought in past month' },
    analysisProfitInputs: { ...DEFAULT_PROFIT_RATES, salePrice: 25, purchaseCostCny: 8, fulfillmentMode: 'FBA', fulfillmentFee: 3.64,
      exchangeRate: 4.8, actualWeightKg: 0.14, airFreightActualWeightOnly: true, volumetricDivisor: 139 },
    ...extra,
  }, { runState: { id: 'review-range-fixture', marketplace: 'AU' }, criteria });
}

test('export audit uses the same range and leaves unknown reviews pending', () => {
  const criteria = { minReviews: 20, maxReviews: 100 };
  for (const reviews of [20, 100]) assert.equal(evaluate(reviews, criteria).filter.decision, 'pass');
  assert.ok(evaluate(19, criteria).filter.reasons.includes('REVIEWS_BELOW_MINIMUM'));
  assert.ok(evaluate(101, criteria).filter.reasons.includes('REVIEWS_ABOVE_MAXIMUM'));
  const unknown = evaluate(null, criteria);
  assert.equal(unknown.filter.decision, 'pending');
  assert.ok(unknown.filter.reasons.includes('REVIEWS_MISSING'));
  assert.equal(evaluate(0, { maxReviews: 0 }).filter.decision, 'pass');
  assert.throws(() => evaluate(25, { minReviews: 100, maxReviews: 20 }), RangeError);
});

test('imported review rules cannot loosen the user range and disjoint rules fail closed', () => {
  assert.deepEqual(intersectReviewRanges({ minReviews: 20, maxReviews: 100 }, { minReviews: 50, maxReviews: 200 }), { minReviews: 50, maxReviews: 100 });
  const extra = { storeCriteria: [{ minReviews: 50, maxReviews: 200 }] };
  assert.equal(evaluate(50, { minReviews: 20, maxReviews: 100 }, extra).filter.decision, 'pass');
  assert.ok(evaluate(101, { minReviews: 20, maxReviews: 100 }, extra).filter.reasons.includes('REVIEWS_ABOVE_MAXIMUM'));
  assert.ok(evaluate(49, { minReviews: 20, maxReviews: 100 }, extra).filter.reasons.includes('REVIEWS_BELOW_MINIMUM'));
  const conflict = evaluate(150, { maxReviews: 100 }, { storeCriteria: [{ minReviews: 200 }] });
  assert.equal(conflict.filter.decision, 'excluded');
  assert.ok(conflict.filter.reasons.includes('STORE_IMPORT_RULE_CONFLICT'));
});
