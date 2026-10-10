import assert from 'node:assert/strict';
import test from 'node:test';
import { createAmazonStoreSession, parseAmazonStorePage } from '../lib/amazon-store-client.mjs';
import { candidateFilterExclusionReasons } from '../server.mjs';

// Collect every store card; explicit per-ASIN monthly purchase evidence gates candidates later.
// Missing badges mean unknown monthly sales, never an inferred count.

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
  assert.equal(result.badgeGateActive, false);
  assert.equal(result.salesByAsin.B0A0000001.sales30, 50);
  assert.equal(result.salesByAsin.B0A0000002.sales30, 100);
  assert.equal(result.salesByAsin.B0A0000003.sales30, 200);
  assert.equal(result.salesByAsin.B0A0000004.sales30, 1200);
  assert.equal(result.salesByAsin.B0A0000004.rawText, '1.2K+ bought in past month');
});

test('all store cards are collected while their original sales evidence stays separate', () => {
  const result = parseAmazonStorePage(storePage(
    cardWithBadge('B0A0000001', '100+ bought in past month'),
    cardWithBadge('B0A0000002', null),
    cardWithBadge('B0A0000003', '30+ bought in past month'),
    cardWithBadge('B0A0000004', null),
  ));
  assert.deepEqual(result.asins, ['B0A0000001', 'B0A0000002', 'B0A0000003', 'B0A0000004']);
  assert.equal(result.excludedUnder50Count, 3);
  assert.deepEqual(Object.keys(result.salesByAsin), ['B0A0000001', 'B0A0000003']);
  assert.equal(result.salesByAsin.B0A0000003.sales30, 30);
});

test('a page with no sales badges retains every card for detail collection', () => {
  const result = parseAmazonStorePage(storePage(
    cardWithBadge('B0A0000001', null),
    cardWithBadge('B0A0000002', null),
  ));
  assert.deepEqual(result.asins, ['B0A0000001', 'B0A0000002']);
  assert.equal(result.excludedUnder50Count, 2);
  assert.equal(result.badgeGateActive, false);
  assert.deepEqual(result.salesByAsin, {});
});

test('linked variants remain provenance and never inherit a card sales badge', () => {
  const result = parseAmazonStorePage(storePage(
    cardWithBadge('B0A0000001', '100+ bought in past month'),
    `<div data-component-type="s-search-result" data-asin="B0A0000002">
      <a href="/dp/B0A0000009?th=1">variant</a>
    </div>`,
  ));
  assert.deepEqual(result.asins, ['B0A0000001', 'B0A0000002']);
  assert.equal(result.variantLinks.length, 1);
  assert.equal(result.salesByAsin.B0A0000009, undefined);
});

test('a page with no eligible candidates is still collected in full', () => {
  const result = parseAmazonStorePage(storePage(
    cardWithBadge('B0A0000001', null),
    cardWithBadge('B0A0000002', '10+ bought in past month'),
  ));
  assert.deepEqual(result.asins, ['B0A0000001', 'B0A0000002']);
  assert.equal(result.badgeGateActive, false);
  assert.equal(result.excludedUnder50Count, 2);
  assert.equal(result.navigationError, false);
  assert.equal(result.explicitEmpty, false);
});

// 亚马逊准则 2026-10-09：详情采集结束后仍未显示月销量标识（或 <50）的竞品不进入初筛。
const item = (overrides = {}) => ({
  asin: 'B0A0000001',
  sales30Evidence: typeof overrides.sales30 === 'number' ? { source: 'amazon_product_page', rawText: `${overrides.sales30}+ bought in past month`, value: overrides.sales30, asin: 'B0A0000001', period: 'past_month', kind: 'lower_bound' } : null,
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

test('pending details without sales evidence cannot qualify as a candidate', () => {
  const pending = candidateFilterExclusionReasons(item({ detailStatus: 'pending', sales30: null }), filters());
  assert.deepEqual(pending, ['MONTHLY_SALES_BELOW_50']);
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


test('a numeric sales count without explicit Amazon evidence cannot qualify', () => {
  assert.deepEqual(candidateFilterExclusionReasons(item({ sales30: 100, sales30Evidence: null }), filters()), ['MONTHLY_SALES_BELOW_50']);
});

test('ordinary spans with explicit monthly purchase text provide per-card evidence', () => {
  const result = parseAmazonStorePage(storePage('<div data-component-type="s-search-result" data-asin="B0A0000001"><span class="a-size-base a-color-secondary">50+ bought in past month</span></div>'));
  assert.deepEqual(result.asins, ['B0A0000001']);
  assert.equal(result.salesByAsin.B0A0000001.sales30, 50);
});

test('linked variants require their own badge and do not inherit the enclosing card badge', () => {
  const result = parseAmazonStorePage(storePage(
    cardWithBadge('B0A0000001', '100+ bought in past month').replace('</div>', '<a href="/dp/B0A0000009">variant</a></div>'),
    cardWithBadge('B0A0000009', null),
  ));
  assert.deepEqual(result.asins, ['B0A0000001', 'B0A0000009']);
  assert.equal(result.salesByAsin.B0A0000009, undefined);
  assert.deepEqual(result.variantLinks, [{cardAsin:'B0A0000001',linkedAsin:'B0A0000009',relationship:'linked_product_unverified_variant'}]);
});

test('nested ASIN badges cannot qualify their enclosing result card', () => {
  const result = parseAmazonStorePage(storePage('<div data-component-type="s-search-result" data-asin="B0A0000001"><div data-asin="B0A0000009"><span class="social-proofing-faceout-title-text">100+ bought in past month</span></div></div>'));
  assert.deepEqual(result.asins, ['B0A0000001']);
  assert.deepEqual(result.salesByAsin, {});
});

const seller = 'A123456789';
const pageUrl = (page) => 'https://www.amazon.nl/s?me=' + seller + '&marketplaceID=A1805IZSGTT6HS&page=' + page;
const withTotal = (total, cards, nextPage = null) => '<div id="search"><div data-component-type="s-result-info-bar">' + total + ' results</div>' + cards.join('') + (nextPage ? '<a class="s-pagination-next" href="' + pageUrl(nextPage) + '">Next</a>' : '') + '</div>';
async function mockedStore(t, pages) {
  const calls = [];
  const deny = async () => { throw new Error('Unexpected network/browser request'); };
  const session = await createAmazonStoreSession('NL', {
    executeFetch: async (url) => { const page = Number(new URL(url).searchParams.get('page') || 1); calls.push(page); assert.ok(pages[page], 'Unexpected page'); return new Response(pages[page]); },
    executeRequest: deny, executeBrowser: deny, edgeExecutable: false, requestIntervalMs: 0,
  });
  t.after(() => session.close());
  return {session,calls};
}

test('zero-badge pages paginate to a qualified card without becoming invalid or incomplete', async (t) => {
  const {session,calls} = await mockedStore(t, {
    1: withTotal(3, [cardWithBadge('B0A0000001', null), cardWithBadge('B0A0000002', null)], 2),
    2: withTotal(3, [cardWithBadge('B0A0000003', '50+ bought in past month')]),
  });
  const result = await session.enumerateStore(seller);
  assert.deepEqual(calls, [1,2]);
  assert.deepEqual(result.asins, ['B0A0000001', 'B0A0000002', 'B0A0000003']);
  assert.equal(result.excludedUnder50Count, 2);
  assert.equal(result.notEnumeratedAsins, 0);
  assert.equal(result.complete, true);
});

test('zero-badge final page completes and duplicates do not inflate full collection', async (t) => {
  const {session} = await mockedStore(t, {
    1: withTotal(2, [cardWithBadge('B0A0000001', null)], 2),
    2: withTotal(2, [cardWithBadge('B0A0000001', null), cardWithBadge('B0A0000002', null)]),
  });
  const result = await session.enumerateStore(seller);
  assert.deepEqual(result.asins, ['B0A0000001', 'B0A0000002']);
  assert.equal(result.excludedUnder50Count, 2);
  assert.equal(result.notEnumeratedAsins, 0);
  assert.equal(result.complete, true);
});

test('resuming keeps all collected ASINs but accepts only valid monthly sales evidence', async (t) => {
  const {session,calls} = await mockedStore(t, {2: withTotal(5, [cardWithBadge('B0A0000005', '100+ bought in past month')])});
  const resume = {asins:['B0A0000001','B0A0000002','B0A0000003','B0A0000004'], salesByAsin:{
    B0A0000001:{sales30:50,rawText:'50+ bought in past month'},
    B0A0000002:{sales30:100},
    B0A0000003:{sales30:200,rawText:'20+ bought in past month'},
  }, pagesVisited:1, reportedTotalAsins:5, nextHref:pageUrl(2), pageAudit:[{url:pageUrl(1),status:'success',exhausted:true,reportedTotalAsins:5,reportedTotalKind:'exact'}]};
  const before = structuredClone(resume);
  const result = await session.enumerateStore(seller,{resume});
  assert.deepEqual(calls,[2]);
  assert.deepEqual(result.asins,['B0A0000001','B0A0000002','B0A0000003','B0A0000004','B0A0000005']);
  assert.deepEqual(Object.keys(result.salesByAsin),['B0A0000001','B0A0000005']);
  assert.equal(result.excludedUnder50Count,3);
  assert.equal(result.complete,true);
  assert.deepEqual(resume,before);
});


test('a duplicate card may supply its own missing badge without duplicating collection targets', () => {
  const result = parseAmazonStorePage(storePage(cardWithBadge('B0A0000001', null), cardWithBadge('B0A0000001', '50+ bought in past month')));
  assert.deepEqual(result.asins, ['B0A0000001']);
  assert.equal(result.salesByAsin.B0A0000001.sales30, 50);
  assert.equal(result.excludedUnder50Count, 0);
  assert.equal(result.duplicateAsinCount, 1);
});

test('resume recovers previously observed cards without inventing badge evidence', async t => {
  const {session} = await mockedStore(t, {2: withTotal(3, [cardWithBadge('B0A0000003', '100+ bought in past month')])});
  const result = await session.enumerateStore(seller, {resume: { asins: ['B0A0000001'], salesByAsin: {B0A0000001: {sales30:50, rawText:'50+ bought in past month'}}, pagesVisited:1, reportedTotalAsins:3, nextHref:pageUrl(2), pageAudit:[{url:pageUrl(1),status:'success',observedAsins:['B0A0000001','B0A0000002']}] }});
  assert.deepEqual(result.asins, ['B0A0000001', 'B0A0000002', 'B0A0000003']);
  assert.equal(result.salesByAsin.B0A0000002, undefined);
  assert.equal(result.excludedUnder50Count, 1);
  assert.equal(result.complete, true);
});
