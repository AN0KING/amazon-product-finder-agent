import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseAsinText, parseAsinRows, parseAsinListBuffer, validateDirectAsinStores } from '../lib/asin-list.mjs';
import { AmazonCollectionRunner } from '../lib/amazon-collection-runner.mjs';
import { AMAZON_PRODUCT_DETAIL_PARSER_VERSION } from '../lib/amazon-store-client.mjs';

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'scout-direct-asin-test-'));
const previousDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(temporaryRoot, 'module-state');
const { seedAmazonCollection, discoveryFromAmazonCheckpoint, discoverStore, validateSearchInput,
  candidateFilterExclusionReasons, analyzeProductSearchDiscoveries, analyzeDiscoveredAsins,
  loadAmazonCollectionDetails, executeProductSearch } = await import('../server.mjs');
const { persistenceStore } = await import('../lib/persistence-store.mjs');
await persistenceStore.ready();
if (previousDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
else process.env.SCOUT_DATA_DIR = previousDirectory;
after(async () => {
  await persistenceStore.writeQueue;
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith('scout-direct-asin-test-'));
  await rm(temporaryRoot, { recursive: true, force: true });
});

const A = 'B09V6TRGTD', B = 'B000000002';
const directList = (text = A, marketplace = 'AU') => parseAsinText(text, { marketplace });
const snapshot = () => ({ runState: { id: 'synthetic-asins', marketplace: 'AU', analysisSourceMode: 'amazon_only', criteria: {} },
  storeList: directList(`${A}\n${B}`), products: [] });
const baseInput = () => ({ runId: 'synthetic-asins', marketplace: 'AU', inputMode: 'asins', stores: directList().stores, useSellerSprite: false });

test('plain ASINs normalize and deduplicate without inventing seller identity', () => {
  const parsed = directList(`b09v6trgtd, ${B}\n${A}`, 'CA');
  assert.equal(parsed.inputMode, 'asins');
  assert.equal(parsed.marketplace, 'CA');
  assert.deepEqual(parsed.stores[0].asins, [A, B]);
  assert.equal(parsed.stores[0].sellerId, null);
  assert.equal(parsed.stores[0].sellerName, null);
  assert.equal(parsed.audit.uniqueSellers, 0);
  assert.equal(parsed.audit.uniqueAsins, 2);
  assert.equal(parsed.audit.duplicates, 1);
  assert.equal(parsed.rows[0].productUrl, `https://www.amazon.ca/dp/${A}`);
});

test('explicit imported product URLs retain parameters through validation and both detail callers', async () => {
  const originalUrl = `https://www.amazon.com.au/dp/${A}?th=1&psc=1#productDetails`;
  const parsed = directList(`${A}\n${originalUrl}\nhttps://www.amazon.com.au/dp/${A}?th=2`);
  assert.equal(parsed.rows[0].productUrl, originalUrl);
  assert.equal(parsed.stores[0].productUrls[A], originalUrl, 'The first explicit URL wins without adding an ASIN.');
  assert.deepEqual(parsed.stores[0].asins, [A]);
  const input = validateSearchInput({ ...baseInput(), phase: 'analyze', stores: parsed.stores });
  assert.equal(input.stores[0].productUrls[A], originalUrl);
  const calls = [];
  const createSession = async () => ({ getProductDetail: async (asin, options) => {
    calls.push({ asin, productUrl: options.productUrl });
    return { asin, title: 'Synthetic imported item' };
  }, close: async () => {} });
  await loadAmazonCollectionDetails({ runId: 'synthetic-imported-url', marketplace: 'AU', inputMode: 'asins',
    stores: input.stores, tasks: { [A]: {} } }, [A], undefined, undefined, { createSession });
  await executeProductSearch(input, undefined, { createSession,
    store: { getAmazonStoreCheckpoints: async () => ({}), getRunToolCalls: () => ({ total: 0 }), appendSearchBatch: async () => {} } });
  assert.deepEqual(calls, [{ asin: A, productUrl: originalUrl }, { asin: A, productUrl: originalUrl }]);
});

test('saved imported URLs cannot change ASIN, marketplace, or import scope', () => {
  for (const productUrls of [
    { [A]: `https://www.amazon.com.au/dp/${B}?th=1` },
    { [A]: `https://www.amazon.ca/dp/${A}?th=1` },
    { [B]: `https://www.amazon.com.au/dp/${B}?th=1` },
    { [A]: `https://www.amazon.com.au.evil.test/dp/${A}` },
  ]) {
    const stores = [{ ...directList(A).stores[0], productUrls }];
    assert.throws(() => validateDirectAsinStores(stores, 'AU'));
    assert.throws(() => validateSearchInput({ ...baseInput(), stores }));
  }
  const asinColumn = parseAsinRows([['ASIN', 'productUrl'], [A, `https://www.amazon.com.au/dp/${B}?th=1`]]);
  assert.deepEqual(asinColumn.stores[0].asins, [A]);
  assert.equal(asinColumn.stores[0].productUrls, undefined);
});

test('links override selected market but do not move bare ASINs across sites', () => {
  const parsed = directList(`https://www.amazon.ca/title/dp/${A}/ref=x?tag=example`, 'AU');
  assert.equal(parsed.marketplace, 'CA');
  assert.equal(parsed.rows[0].productUrl, `https://www.amazon.ca/title/dp/${A}/ref=x?tag=example`);
  assert.throws(() => directList(`${B} https://www.amazon.ca/dp/${A}`, 'AU'), { code: 'ASIN_MARKETPLACE_MISMATCH' });
  assert.throws(() => directList(`https://amazon.ca/dp/${A} https://amazon.com.au/dp/${B}`), { code: 'ASIN_MARKETPLACE_MISMATCH' });
  assert.equal(directList(`https://amazon.ca/dp/${A} ${A}`, 'CA').audit.uniqueAsins, 1);
});

test('all malformed input rejects atomically instead of silently losing requested products', async () => {
  for (const bad of ['bad', 'B09V6TRGTDD', `https://amazon.ca.evil.example/dp/${A}`,
    `https://user@amazon.ca/dp/${A}`, `https://amazon.ca:1234/dp/${A}`, `https://amazon.ca/s?k=${A}`, `https://amzn.to/${A}`]) {
    assert.throws(() => directList(`${A}\n${bad}`));
  }
  assert.throws(() => directList(''), { code: 'EMPTY_ASIN_LIST' });
  assert.throws(() => directList(42), { code: 'INVALID_ASIN_INPUT' });
  await assert.rejects(parseAsinListBuffer(Buffer.from('not-xlsx')), { code: 'INVALID_XLSX' });
});

test('Excel ASIN column owns scope and ignores URL columns while pure URL sheets still detect marketplace', () => {
  const parsed = parseAsinRows([['ASIN', '商品链接'], [A, `https://amazon.ca/gp/product/${A}`]], { marketplace: 'AU' });
  assert.equal(parsed.marketplace, 'AU');
  assert.equal(parsed.audit.sourceColumn, 'asin');
  assert.equal(parsed.audit.uniqueAsins, 1);
  const mismatchedUrl = parseAsinRows([['ASIN', '商品链接'], [A, `https://amazon.ca/dp/${B}`]]);
  assert.deepEqual(mismatchedUrl.stores[0].asins, [A]);
  const declared = parseAsinRows([['ASIN', '商品链接', '站点'], [A, `https://amazon.ca/dp/${A}`, 'AU']]);
  assert.equal(declared.marketplace, 'AU');
  const blank = parseAsinRows([['ASIN', '商品链接'], [A, 'bad URL'], ['', `https://amazon.ca/dp/${B}`]]);
  assert.deepEqual(blank.stores[0].asins, [A]);
  assert.equal(blank.audit.skippedBlankAsinRows, 1);
  assert.equal(blank.issues[0].code, 'EMPTY_ASIN_CELL_SKIPPED');
  const urlOnly = parseAsinRows([['商品链接'], [`https://amazon.ca/dp/${B}`]], { marketplace: 'AU' });
  assert.equal(urlOnly.marketplace, 'CA');
  assert.equal(urlOnly.audit.sourceColumn, 'product_url');
  assert.throws(() => parseAsinRows([['ASIN', '商品链接'], ['bad', `https://amazon.ca/dp/${B}`]]), { code: 'INVALID_ASIN_INPUT' });
  assert.throws(() => parseAsinRows([['ASIN', '商品链接'], ['', `https://amazon.ca/dp/${B}`]]), { code: 'EMPTY_ASIN_LIST' });
  assert.throws(() => parseAsinRows([['商品链接'], [`https://amazon.ca/dp/${B}`]], { requireAsinColumn: true }), { code: 'ASIN_COLUMN_REQUIRED' });
  assert.throws(() => parseAsinRows([['标题'], ['no ASIN header']]), { code: 'INVALID_ASIN_INPUT' });
});

test('headerless single-column product workbooks keep all nine rows without seller enumeration', () => {
  const requested = Array.from({ length: 9 }, (_, index) => `B${String(index + 1).padStart(9, '0')}`);
  const parsed = parseAsinRows(requested.map(asin => [`https://www.amazon.com.au/product/dp/${asin}?m=TESTSELLER01&th=1`]), { marketplace: 'CA' });
  assert.deepEqual(parsed.stores[0].asins, requested);
  assert.equal(parsed.rows[0].asin, requested[0]);
  assert.equal(parsed.rows[0].rowNumber, 1);
  assert.equal(parsed.audit.rawRows, 9);
  assert.equal(parsed.audit.uniqueAsins, 9);
  assert.equal(parsed.audit.sourceColumn, 'product_url');
  assert.equal(parsed.audit.sourceFormat, 'headerless_single_column');
  assert.equal(parsed.marketplace, 'AU');
  assert.equal(parsed.stores[0].sellerId, null);
  assert.equal(parsed.stores[0].sellerUrl, null);
  assert.equal(parsed.audit.uniqueSellers, 0);
  assert.ok(parsed.rows.every(row => row.productUrl.endsWith('?m=TESTSELLER01&th=1')));
  const plain = parseAsinRows([[A], [], [B]], { marketplace: 'CA' });
  assert.deepEqual(plain.stores[0].asins, [A, B]);
  assert.equal(plain.marketplace, 'CA');
  assert.equal(plain.audit.sourceColumn, 'asin');
  assert.deepEqual(plain.rows.map(row => row.rowNumber), [1, 3]);
});

test('HTTP imports upgrade to HTTPS without discarding the requested product options', () => {
  const parsed = directList(`http://amazon.com.au/gp/aw/d/${A}?th=1&psc=1#productDetails`);
  assert.equal(parsed.stores[0].productUrls[A], `https://amazon.com.au/gp/aw/d/${A}?th=1&psc=1#productDetails`);
});

test('headerless files reject any invalid row or ambiguous column without accepting a partial scope', () => {
  for (const invalid of ['invalid', `https://amazon.com.au/s?me=TESTSELLER01&asin=${A}`,
    `https://amazon.com.au/sp?seller=TESTSELLER01&m=${A}`]) {
    assert.throws(() => parseAsinRows([[A], [invalid], [B]]));
  }
  assert.throws(() => parseAsinRows([[A, 'title'], [B, 'other title']]), { code: 'AMBIGUOUS_ASIN_COLUMNS' });
  assert.throws(() => parseAsinRows([[A, null], [null, B]]), { code: 'AMBIGUOUS_ASIN_COLUMNS' });
  assert.throws(() => parseAsinRows([[A], [B]], { requireAsinColumn: true }), { code: 'ASIN_COLUMN_REQUIRED' });
});

test('direct ASIN batches support over 100 inputs, enforce hard limit and reject seller scope', () => {
  const asins = Array.from({ length: 101 }, (_, i) => `B${String(i).padStart(9, '0')}`);
  const parsed = directList(asins.join('\n'));
  assert.equal(validateSearchInput({ ...baseInput(), stores: parsed.stores }).stores[0].asins.length, 101);
  assert.throws(() => validateSearchInput({ ...baseInput(), stores: [{ ...parsed.stores[0], sellerId: 'SELLERID01' }] }), { code: 'INVALID_ASIN_INPUT' });
  assert.throws(() => validateSearchInput({ ...baseInput(), stores: [{ ...parsed.stores[0], sellerUrl: 'https://amazon.com.au/s?me=SELLERID01' }] }), { code: 'INVALID_ASIN_INPUT' });
  assert.throws(() => validateDirectAsinStores([{ asins: Array(10001).fill(A) }], 'AU'), { code: 'TOO_MANY_ASINS' });
});

test('seeding direct ASINs ignores unrelated snapshots and goes directly to details', async () => {
  const saved = snapshot();
  saved.products = [{ asin: 'B000000003', sourceStores: [{ sellerId: 'FOREIGN01' }] }];
  const seeded = await seedAmazonCollection(saved, { store: { readRunFile: async () => ({ amazonStoreCheckpoints: {}, searchBatches: [] }) } });
  assert.equal(seeded.discoveryComplete, true);
  assert.deepEqual(seeded.targets.map(item => item.asin), [A, B]);
  assert.ok(seeded.targets.every(item => item.sourceStores.every(store => !store.sellerId && !store.sellerName)));
  const discovery = discoveryFromAmazonCheckpoint({ ...saved.storeList.stores[0], storeIndex: 0 }, null);
  assert.equal(discovery.visit.complete, true);
  assert.equal(discovery.visit.code, null);
  const directDiscovery = await discoverStore(saved.storeList.stores[0], new Proxy({}, { get() { throw new Error('Must not enumerate shops'); } }), null,
    new AbortController().signal, { runId: saved.runState.id });
  assert.equal(directDiscovery.visit.status, 'not_required');
  assert.equal(directDiscovery.visit.pagesVisited, 0);
});

test('same direct source ASINs reach Amazon or explicitly enabled SellerSprite analysis', async () => {
  const store = directList(A, 'CA').stores[0];
  const discovery = discoveryFromAmazonCheckpoint({ ...store, storeIndex: 0 }, null);
  const observed = [];
  await analyzeProductSearchDiscoveries([discovery], { ...baseInput(), marketplace: 'CA', phase: 'analyze', filters: {}, detailAsins: [A] },
    new Date().toISOString(), new AbortController().signal, { amazonDetailLoader: async asin => {
      observed.push(['amazon', asin]); return { asin, title: 'Synthetic', reviewCount: 100 };
    } });
  assert.deepEqual(observed, [['amazon', A]]);
  const requests = [];
  await analyzeProductSearchDiscoveries([discovery], { ...baseInput(), marketplace: 'CA', phase: 'analyze', useSellerSprite: true, filters: {} },
    new Date().toISOString(), new AbortController().signal, {
      competitorLookupLoader: async request => { requests.push(request); return []; },
      sellerSpriteAnalyzer: (discoveries, input, collectedAt, signal, options) => analyzeDiscoveredAsins(discoveries, input, collectedAt, signal, {
        ...options, competitorLookupPersistence: { getCompetitorLookupResults: async () => ({}), saveCompetitorLookupBatch: async () => {} },
      }),
    });
  assert.equal(requests.length, 1);
  assert.ok(JSON.stringify(requests[0]).includes(A));
});

test('server review bounds are inclusive, preserve zero and distinguish unavailable review count', () => {
  const filters = validateSearchInput({ ...baseInput(), filters: { minReviews: '0', maxReviews: '100' } }).filters;
  assert.equal(filters.minReviews, 0); assert.equal(filters.maxReviews, 100);
  for (const reviewCount of [0, 100]) assert.equal(candidateFilterExclusionReasons({ reviewCount }, filters).some(reason => reason.startsWith('REVIEWS_')), false);
  assert.ok(candidateFilterExclusionReasons({ reviewCount: 101 }, filters).includes('REVIEWS_ABOVE_MAXIMUM'));
  assert.ok(candidateFilterExclusionReasons({ reviewCount: null, detailStatus: 'pending' }, filters).includes('REVIEWS_MISSING'));
  for (const range of [{ minReviews: 5, maxReviews: 4 }, { maxReviews: 1.5 }, { maxReviews: true }, { maxReviews: Number.MAX_SAFE_INTEGER + 1 }, { minReviews: -1 }, { maxReviews: '1e3' }]) {
    assert.throws(() => validateSearchInput({ ...baseInput(), filters: range }), { code: 'INVALID_REVIEW_COUNT' });
  }
});

const salesItem = (asin, sales30) => ({ asin, detailStatus: 'success', title: 'Synthetic imported product',
  rating: 4.5, reviewCount: 20, sales30, sales30Evidence: sales30 === null ? null : {
    source: 'amazon_product_page', asin, value: sales30, rawText: `${sales30}+ bought in past month`,
    kind: 'lower_bound', period: 'past_month',
  } });

test('ASIN all preserves every product while explicit monthly bands apply without changing evidence', () => {
  for (const monthlySalesBand of ['all', '50_plus', '50_to_100', '100_plus']) {
    const filters = { monthlySalesBand, minRating: 4, minReviews: 10, maxReviews: 30 };
    for (const sales30 of [null, 0, 10, 49, 50, 60, 200]) {
      const item = salesItem(A, sales30);
      const before = structuredClone(item);
      assert.deepEqual(candidateFilterExclusionReasons(item, filters, { inputMode: 'asins' }), monthlySalesBand === 'all' ? [] : candidateFilterExclusionReasons(item, filters, { inputMode: 'stores' }));
      assert.deepEqual(item, before, 'Sales values and evidence remain unchanged.');
    }
    assert.deepEqual(candidateFilterExclusionReasons({ ...salesItem(A, null), rating: 3, reviewCount: 40 }, filters, { inputMode: 'asins' }),
      [...(monthlySalesBand === 'all' ? [] : ['MONTHLY_SALES_EVIDENCE_MISSING']), 'RATING_BELOW_MINIMUM', 'REVIEWS_ABOVE_MAXIMUM']);
    assert.deepEqual(candidateFilterExclusionReasons({ ...salesItem(A, 0), reviewCount: 2 }, filters, { inputMode: 'asins' }), [...(monthlySalesBand === 'all' ? [] : ['MONTHLY_SALES_BELOW_50']), 'REVIEWS_BELOW_MINIMUM']);
  }
  const low = { ...salesItem(A, 10), inputMode: 'asins', skipMonthlySales: true };
  const filters = { monthlySalesBand: 'all', minRating: null, minReviews: null, skipMonthlySales: true, inputMode: 'asins' };
  assert.deepEqual(candidateFilterExclusionReasons(low, filters), ['MONTHLY_SALES_BELOW_50'], 'Product/filter flags cannot override task mode.');
  assert.throws(() => validateSearchInput({ ...baseInput(), filters: { skipMonthlySales: true } }), { code: 'INVALID_FILTERS' });
  assert.throws(() => validateSearchInput({ ...baseInput(), skipMonthlySales: true }), { code: 'UNKNOWN_SEARCH_FIELD' });
});

test('saved direct ASIN results retain monthly exclusions without recollection', async () => {
  const saved = snapshot();
  saved.runState.criteria = { monthlySalesBand: '100_plus', minReviews: 10, maxReviews: 30 };
  const cached = [
    { ...salesItem(A, null), detailParserVersion: AMAZON_PRODUCT_DETAIL_PARSER_VERSION, filterMatch: false, filterExclusionReasons: ['MONTHLY_SALES_EVIDENCE_MISSING'] },
    { ...salesItem(B, 10), reviewCount: 40, detailParserVersion: AMAZON_PRODUCT_DETAIL_PARSER_VERSION, filterMatch: false,
      filterExclusionReasons: ['MONTHLY_SALES_BELOW_50', 'REVIEWS_ABOVE_MAXIMUM'] },
  ];
  const before = structuredClone(cached);
  const result = await seedAmazonCollection(saved, { store: { readRunFile: async () => ({ searchBatches: [{ marketplace: 'AU', response: { items: cached } }] }) } });
  assert.equal(result.items[0].filterMatch, false);
  assert.deepEqual(result.items[0].filterExclusionReasons, ['MONTHLY_SALES_EVIDENCE_MISSING']);
  assert.equal(result.items[0].sales30, null);
  assert.equal(result.items[1].filterMatch, false);
  assert.deepEqual(result.items[1].filterExclusionReasons, ['MONTHLY_SALES_BELOW_50', 'REVIEWS_ABOVE_MAXIMUM']);
  assert.deepEqual(cached, before, 'Re-evaluation does not mutate the saved source.');
});

test('background and search direct ASIN details preserve every observation while applying sales filters', async () => {
  const asins = [A, B, 'B000000003', 'B000000004'];
  const sales = [null, 0, 10, 200];
  const details = Object.fromEntries(asins.map((asin, index) => [asin, salesItem(asin, sales[index])]));
  for (const inputMode of ['asins', 'stores']) {
    const calls = [], persisted = [], streamed = [];
    let closed = 0;
    const createSession = async () => ({ getProductDetail: async asin => { calls.push(asin); return details[asin]; }, close: async () => { closed += 1; } });
    const filters = { monthlySalesBand: '100_plus', minRating: 4, minReviews: 10, maxReviews: 30 };
    const job = { runId: 'synthetic-monthly-bypass', marketplace: 'AU', inputMode, filters, tasks: Object.fromEntries(asins.map(asin => [asin, {}])) };
    const result = await loadAmazonCollectionDetails(job, asins, undefined, item => streamed.push(item), { createSession });
    assert.deepEqual(result.map(item => item.sales30), sales);
    assert.deepEqual(result.map(item => item.filterMatch), [false, false, false, true]);
    assert.deepEqual(streamed.map(item => item.filterMatch), result.map(item => item.filterMatch));
    assert.deepEqual(calls, asins);
    const input = validateSearchInput({ ...baseInput(), runId: job.runId, inputMode, phase: 'analyze', filters, stores: directList(asins.join('\n')).stores });
    const response = await executeProductSearch(input, undefined, { createSession,
      store: { getAmazonStoreCheckpoints: async () => ({}), getRunToolCalls: () => ({ total: 0 }), appendSearchBatch: async (_runId, batch) => persisted.push(batch) } });
    assert.equal(response.inputMode, inputMode);
    assert.equal(response.appliedFilters.monthlySalesFilterApplied, true);
    assert.equal(response.appliedFilters.monthlySalesBand, '100_plus');
    assert.equal(response.analysisAudit.selectedCandidates, 1);
    assert.deepEqual(asins.map(asin => response.items.find(item => item.asin === asin).filterMatch), result.map(item => item.filterMatch));
    assert.equal(persisted.length, 1);
    assert.equal(closed, 2);
  }
});

class MemoryStore {
  constructor(saved = snapshot()) { this.snapshot = saved; this.value = { job: null, items: {} }; this.active = null; }
  async getRunSnapshot() { return structuredClone(this.snapshot); }
  async getActiveAmazonCollection() { return this.active ? { runId: this.active, ...structuredClone(this.value) } : null; }
  async getAmazonCollection() { return structuredClone(this.value); }
  async updateAmazonCollection(runId, updater, { activate } = {}) {
    this.value = structuredClone(updater(structuredClone(this.value))); if (activate) this.active = runId; return this.getAmazonCollection();
  }
}

test('direct task uses saved checkpoints and never discovers shops, paused/archive protection remains', async t => {
  const store = new MemoryStore();
  const calls = [];
  const runner = new AmazonCollectionRunner({ store,
    seed: saved => seedAmazonCollection(saved, { store: { readRunFile: async () => ({}) } }),
    discover: async () => { throw new Error('Unexpected shop discovery'); },
    loadDetails: async (job, asins) => { calls.push([...asins]); return asins.map(asin => ({ asin, detailStatus: 'success', marketplace: 'AU' })); },
  });
  t.after(() => runner.close());
  const started = await runner.start('synthetic-asins');
  assert.equal(started.phase, 'details'); assert.equal(started.inputMode, 'asins');
  await runner.tick();
  assert.deepEqual(calls, [[A, B]]);
  assert.equal((await runner.status()).status, 'completed');
  store.snapshot.runState.archivedAt = '2026-10-01T00:00:00.000Z';
  const archivedRunner = new AmazonCollectionRunner({ store });
  await assert.rejects(archivedRunner.start('synthetic-asins'), { code: 'RUN_ARCHIVED' });
  await archivedRunner.close();
});

for (const [status, causeCode] of [['paused', 'USER_PAUSED'], ['needs_attention', 'AMAZON_ACCESS_CHALLENGE']]) {
  test(`old missing-field evidence migration preserves ${causeCode}, manual data and no new visits`, async t => {
    const store = new MemoryStore();
    store.active = 'synthetic-asins';
    store.value = { job: { runId: store.active, marketplace: 'AU', revision: 1, status, causeCode, enabled: false, phase: 'details', discoveryComplete: true,
      tasks: { [A]: { status: 'partial', attempts: 1 } } }, items: { [A]: {
      asin: A, detailStatus: 'success', productWeightKg: 0.14, manualAmazonFields: { productWeightKg: true },
      fieldSources: { productWeightKg: 'manual' }, purchaseCost: 8,
      productInformation: { version: 1, asin: A, status: 'complete', weightStatus: 'not_provided', rows: [] },
      amazonFirstAvailableDate: null, amazonFirstAvailableDateStatus: 'not_provided', collectionQuality: { version: 2 },
    } } };
    const runner = new AmazonCollectionRunner({ store, discover: () => assert.fail('Unexpected visit'), loadDetails: () => assert.fail('Unexpected visit') });
    t.after(() => runner.close());
    await runner.initialize({ timer: false });
    await runner.tick();
    const saved = await store.getAmazonCollection();
    assert.equal(saved.job.status, status); assert.equal(saved.job.causeCode, causeCode); assert.equal(saved.job.enabled, false);
    assert.equal(saved.items[A].productWeightKg, 0.14); assert.equal(saved.items[A].purchaseCost, 8);
    assert.equal(saved.items[A].productInformation.weightStatus, 'unresolved');
    assert.equal(saved.items[A].amazonFirstAvailableDateStatus, 'unresolved');
  });
}
