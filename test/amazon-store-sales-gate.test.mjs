import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAmazonStorePage } from '../lib/amazon-store-client.mjs';
import { candidateFilterExclusionReasons } from '../server.mjs';

// 亚马逊准则 2026-10-09：店铺首页卡片角标门控。
// 无角标 = 月销量 50 以下 → 不纳入候选；50+/100+/200+/1000+（含 1.2K+ 缩写）→ 保留并记录下界。

const cardWithBadge = (asin, badgeText) => `
  <div data-component-type="s-search-result" data-asin="${asin}">
    <img class="s-image" alt="cover" />
    ${badgeText ? `<span id="social-proofing-faceout-title-tk_bought">${badgeText}</span>` : ''}
  </div>`;

const storePage = (...cards) => `<div id="search">${cards.join('')}</div>`;

test('store cards showing a monthly sales badge of 50+ are kept and recorded', () => {
  const result = parseAmazonStorePage(storePage(
    cardWithBadge('B0A0000001', '50+ bought in past month'),
    cardWithBadge('B0A0000002', '100+ bought in past month'),
    cardWithBadge('B0A0000003', '200+ bought in past month'),
    cardWithBadge('B0A0000004', '1.2K+ bought in past month'),
  ));
  assert.deepEqual(result.asins, ['B0A0000001', 'B0A0000002', 'B0A0000003', 'B0A0000004']);
  assert.equal(result.excludedUnder50Count, 0);
  assert.equal(result.badgeGateActive, true);
  assert.equal(result.salesByAsin.B0A0000001.sales30, 50);
  assert.equal(result.salesByAsin.B0A0000002.sales30, 100);
  assert.equal(result.salesByAsin.B0A0000003.sales30, 200);
  assert.equal(result.salesByAsin.B0A0000004.sales30, 1200);
  assert.equal(result.salesByAsin.B0A0000004.rawText, '1.2K+ bought in past month');
});

test('store cards without a sales badge are excluded while other cards show badges', () => {
  const result = parseAmazonStorePage(storePage(
    cardWithBadge('B0A0000001', '100+ bought in past month'),
    cardWithBadge('B0A0000002', null),
    cardWithBadge('B0A0000003', '30+ bought in past month'),
    cardWithBadge('B0A0000004', null),
  ));
  assert.deepEqual(result.asins, ['B0A0000001']);
  assert.equal(result.excludedUnder50Count, 3);
  assert.deepEqual(Object.keys(result.salesByAsin), ['B0A0000001']);
});

test('a page where no card shows any badge keeps all cards (badge parsing not reliable)', () => {
  const result = parseAmazonStorePage(storePage(
    cardWithBadge('B0A0000001', null),
    cardWithBadge('B0A0000002', null),
  ));
  assert.deepEqual(result.asins, ['B0A0000001', 'B0A0000002']);
  assert.equal(result.excludedUnder50Count, 0);
  assert.equal(result.badgeGateActive, false);
  assert.deepEqual(result.salesByAsin, {});
});

test('variant links of an excluded card are not collected', () => {
  const result = parseAmazonStorePage(storePage(
    cardWithBadge('B0A0000001', '100+ bought in past month'),
    `<div data-component-type="s-search-result" data-asin="B0A0000002">
      <a href="/dp/B0A0000009?th=1">variant</a>
    </div>`,
  ));
  assert.deepEqual(result.asins, ['B0A0000001']);
  assert.equal(result.variantLinks.length, 0);
});

test('a page whose cards are all gated out is not an invalid store page', () => {
  const result = parseAmazonStorePage(storePage(
    cardWithBadge('B0A0000001', null),
    cardWithBadge('B0A0000002', '10+ bought in past month'),
  ));
  assert.deepEqual(result.asins, []);
  assert.equal(result.badgeGateActive, true);
  assert.equal(result.excludedUnder50Count, 2);
  assert.equal(result.navigationError, false);
  assert.equal(result.explicitEmpty, false);
});

// 亚马逊准则 2026-10-09：详情采集结束后仍未显示月销量标识（或 <50）的竞品不进入初筛。
const item = (overrides = {}) => ({
  detailStatus: 'success',
  sales30: null,
  rating: 4.5,
  reviewCount: 30,
  ...overrides,
});
const filters = (overrides = {}) => ({ monthlySalesBand: 'all', minRating: null, minReviews: null, ...overrides });

test('items without a monthly sales badge are excluded from screening once details are collected', () => {
  const missing = candidateFilterExclusionReasons(item({ sales30: null }), filters());
  assert.deepEqual(missing, ['MONTHLY_SALES_BELOW_50']);
  const zero = candidateFilterExclusionReasons(item({ sales30: 0 }), filters());
  assert.deepEqual(zero, ['MONTHLY_SALES_BELOW_50']);
  const under = candidateFilterExclusionReasons(item({ sales30: 49 }), filters());
  assert.deepEqual(under, ['MONTHLY_SALES_BELOW_50']);
});

test('pending details still wait for real sales data and are not excluded yet', () => {
  const pending = candidateFilterExclusionReasons(item({ detailStatus: 'pending', sales30: null }), filters());
  assert.deepEqual(pending, []);
});

test('items at or above the 50 floor pass the all band, and band ranges still apply', () => {
  assert.deepEqual(candidateFilterExclusionReasons(item({ sales30: 50 }), filters()), []);
  assert.deepEqual(candidateFilterExclusionReasons(item({ sales30: 1200 }), filters()), []);
  assert.deepEqual(
    candidateFilterExclusionReasons(item({ sales30: 120 }), filters({ monthlySalesBand: '50_to_100' })),
    ['MONTHLY_SALES_OUTSIDE_50_TO_100'],
  );
  assert.deepEqual(
    candidateFilterExclusionReasons(item({ sales30: 60 }), filters({ monthlySalesBand: '100_plus' })),
    ['MONTHLY_SALES_BELOW_100'],
  );
});
