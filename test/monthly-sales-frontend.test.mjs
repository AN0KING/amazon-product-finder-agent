import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as salesPolicy from '../lib/monthly-sales-policy.mjs';
import * as priceState from '../lib/amazon-price-state.mjs';
import * as profitModel from '../lib/profit-model.mjs';
import * as pieceCount from '../lib/title-piece-count.mjs';
import * as handoff from '../lib/analysis-handoff.mjs';
import * as coverage from '../lib/analysis-coverage.mjs';
import * as detailRetry from '../lib/amazon-detail-retry.mjs';

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'scout-monthly-ui-'));
const previousDataDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(temporaryRoot, 'module-default');
let candidateFilterExclusionReasons;
try { ({ candidateFilterExclusionReasons } = await import('../server.mjs')); }
finally {
  if (previousDataDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
  else process.env.SCOUT_DATA_DIR = previousDataDirectory;
}
after(async () => {
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith('scout-monthly-ui-'));
  await rm(temporaryRoot, { recursive: true, force: true });
});

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const asin = 'B012345678';
const amazon = (value = 50, extra = {}) => ({ id: `US:${asin}`, asin, sourceAsin: asin, marketplace: 'US', sourceMarketplace: 'US',
  analysisSourceMode: 'amazon_only', detailStatus: 'success', sales30: value, reviews: 100, reviewCount: 100, rating: 4.5,
  name: 'Synthetic product', suppliers: [],
  sales30Evidence: value === null ? null : { source: 'amazon_product_page', period: 'past_month', kind: 'lower_bound', value, rawText: `${value}+ bought in past month`, asin }, ...extra });
const apiProduct = (extra = {}) => amazon(123, { analysisSourceMode: 'amazon_sellsprite',
  sales30Evidence: { source: 'sellsprite_api', sourceTool: 'competitor_lookup', field: 'amzUnit', scope: 'asin', kind: 'estimate', period: 'past_month', asin, marketplace: 'US', providerMarketplace: 'US', value: 123 }, ...extra });

function harness({ marketplace = 'US', enabled = false } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { checked: false, disabled: false, hidden: false, textContent: '', innerHTML: '', value: '', dataset: {}, title: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute(name, value) { this[name] = value; }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; } });
    return elements.get(id);
  };
  const calls = [], toasts = [], errors = [], intervals = [];
  let respond = async url => { throw new Error(`Unexpected API request: ${url}`); };
  const context = vm.createContext({ ...salesPolicy, ...priceState, ...profitModel, ...pieceCount, ...handoff, ...coverage, ...detailRetry,
    structuredClone, AbortController, DOMException, URL,
    document: { addEventListener() {}, getElementById: element, querySelector: element, querySelectorAll() { return []; } },
    window: { setTimeout() {}, clearTimeout() {}, setInterval(callback, ms) { intervals.push({ callback, ms }); }, clearInterval() {} },
    setTimeout() {}, clearTimeout() {},
    async fixtureApi(url, options = {}) { calls.push({ url, options }); return respond(url, options); },
    async fetch(url, options = {}) { calls.push({ url, options }); return respond(url, options); },
    fixtureToast: (...args) => toasts.push(args), fixtureError: (...args) => errors.push(args),
  });
  const source = appSource.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/\}\)\(\);\s*$/, `
    apiRequest = async (path, options) => { const data = await fixtureApi(path, options); updateSellerSpriteCallCount(data?.toolCallCount, data?.sessionToolCallCount); return data; };
    showToast = fixtureToast; showProgressError = fixtureError;
    initIcons = updateStartAvailability = hideProgressError = renderSupplierList = renderProfitPreview = syncProfitEditorSaveButton = renderAnalysisVersionActions = () => {};
    activeMarket = MARKET_CONFIGS['${marketplace}'];
    runState = { ...createIdleRunState(), marketplace: activeMarket.code, mode: 'live', coverage: {} };
    storeList = null;
    globalThis.scout = {
      connect: checkSellerSpriteConnection, configuration: loadSellerSpriteConfiguration,
      counts: updateSellerSpriteCallCount, monitor: loadLocalMonitorStatus, heartbeat: startHeartbeat,
      restoreCriteria: applyStoredCriteriaToInputs, resumeAmazon: scheduleAmazonRunResume,
      filter: singleStoreFilterExclusionReasons, coverage: renderAsinCoverageSummary,
      drawer: populateDrawer, reasons: currentFilterExclusionReasons,
      setProducts: (items, criteria = {}) => { products = items; activeRunCriteria = criteria; },
      state: () => ({ sellerSpriteStatus, sellerSpriteCheckPromise, sellerSpriteCallCount, localMonitorState }),
    };
  })();`);
  vm.runInContext(source, context, { filename: 'app.js' });
  element('useSellerSpriteToggle').checked = enabled;
  return { app: context.scout, element, calls, toasts, errors, intervals, respond(fn) { respond = fn; } };
}

const configuration = { configuration: { configured: true }, capabilities: { supportedMarketplaces: ['US', 'UK', 'DE'] } };
test('source-off connection action performs no configuration read, authorization or business request', async () => {
  const fixture = harness();
  assert.equal(await fixture.app.connect(), false);
  assert.equal(fixture.calls.length, 0);
  assert.match(fixture.toasts[0][0], /先开启/);
});

test('configuration-only inspection remains read-only and identifies an unsupported marketplace', async () => {
  const fixture = harness({ marketplace: 'AU' });
  fixture.respond(async url => { assert.equal(url, '/api/sellsprite/status'); return configuration; });
  await fixture.app.configuration();
  assert.deepEqual(fixture.calls.map(({ url, options }) => [url, options.method || 'GET']), [['/api/sellsprite/status', 'GET']]);
  assert.match(fixture.element('sellerSpriteSetupStatus').textContent, /不支持 AU/);
  assert.match(fixture.element('sellerSpriteSetupStatus').textContent, /不能使用其他站点替代/);
});

test('explicit connection submits one confirmed POST for the current market, coalescing repeated clicks', async () => {
  const fixture = harness({ enabled: true });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fixture.respond(async (url, options) => {
    if (url === '/api/sellsprite/status') { await gate; return configuration; }
    assert.equal(url, '/api/sellsprite/connect');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { confirmed: true, marketplace: 'US' });
    return { tools: ['competitor_lookup'], capabilities: configuration.capabilities };
  });
  const first = fixture.app.connect();
  const second = fixture.app.connect();
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(fixture.calls.map(call => call.url), ['/api/sellsprite/status', '/api/sellsprite/connect']);
  assert.equal(fixture.app.state().sellerSpriteStatus, 'live');
  assert.equal(fixture.app.state().sellerSpriteCheckPromise, null);
  assert.equal(fixture.element('sellerSpriteStatusText').textContent, '已连接');
});

test('connection failure displays actionable market errors and leaves the button available', async () => {
  const fixture = harness({ enabled: true, marketplace: 'AU' });
  fixture.respond(async url => {
    if (url === '/api/sellsprite/status') return configuration;
    throw Object.assign(new Error('AU 不受当前接口支持，请使用 Amazon 页面数据。'), { code: 'SELLSPRITE_MARKETPLACE_UNSUPPORTED' });
  });
  assert.equal(await fixture.app.connect(), false);
  assert.equal(fixture.app.state().sellerSpriteStatus, 'error');
  assert.match(fixture.errors[0][0], /当前站点暂无/);
  assert.equal(fixture.element('sellerSpriteRetryButton').disabled, false);
  assert.equal(fixture.app.state().sellerSpriteCheckPromise, null);
});

test('frontend and backend distinguish unknown sales from known low sales and agree on source selection', () => {
  const fixture = harness();
  const rows = [amazon(null), amazon(0), amazon(49), amazon(50), amazon(200), apiProduct(),
    apiProduct({ marketplace: 'AU', sourceMarketplace: 'AU' }), amazon(100, { sales30Evidence: null })];
  for (const useSellerSprite of [false, true]) {
    for (const monthlySalesBand of ['all', '50_to_100', '100_plus']) {
      const criteria = { useSellerSprite, monthlySalesBand, minRating: null, minReviews: null };
      for (const row of rows) assert.deepEqual(Array.from(fixture.app.filter(row, criteria)), candidateFilterExclusionReasons(row, criteria));
    }
  }
  assert.deepEqual(Array.from(fixture.app.filter(amazon(null))), ['MONTHLY_SALES_EVIDENCE_MISSING']);
  assert.deepEqual(Array.from(fixture.app.filter(amazon(49))), ['MONTHLY_SALES_BELOW_50']);
});

test('rendered coverage separates unknown reasons and counts each actual data source', () => {
  const fixture = harness();
  fixture.app.setProducts([amazon(50), amazon(20), apiProduct(), amazon(null, { collectionQuality: { fields: { sales30: { status: 'unavailable' } } } }),
    amazon(null, { detailStatus: 'pending' }), amazon(null, { detailStatus: 'failed' })], { useSellerSprite: true });
  fixture.app.coverage();
  const summary = fixture.element('monthlySalesCoverage').textContent;
  assert.match(summary, /已取得 3 \/ 6/);
  assert.match(summary, /达到 50：2/);
  assert.match(summary, /低于 50：1/);
  assert.match(summary, /未知：3/);
  const detail = fixture.element('monthlySalesCoverageDetail').textContent;
  for (const label of ['页面未提供 1', '待采集 1', '请求失败 1', 'Amazon 2', 'SellerSprite 1']) assert.ok(detail.includes(label), label);
  const reasons = Array.from(fixture.app.reasons()).join(' ');
  assert.match(reasons, /月销量未知或未核验（不等于低于 50）：3/);
  assert.match(reasons, /已取得的月销量低于 50：1/);
  assert.equal(fixture.calls.length, 0);
});

test('detail drawer displays estimates and Amazon lower bounds with the correct source and preserves unknown', () => {
  const fixture = harness();
  for (const [product, expected] of [[amazon(50), /50\+ pcs · Amazon 月购买量提示/], [apiProduct(), /123 pcs · SellerSprite 子体近 30 天估算销量/], [amazon(null), /未知 · 尚无有效月销量，不等于低于 50/]]) {
    fixture.app.drawer(product);
    assert.match(fixture.element('amazonMetrics').innerHTML, expected);
  }
  assert.equal(fixture.calls.length, 0);
});


test('missing optional MCP configuration leaves the Amazon default usable and preserves an explicit source choice', async () => {
  for (const enabled of [false, true]) {
    const fixture = harness({ enabled });
    fixture.respond(async url => {
      assert.equal(url, '/api/sellsprite/status');
      return { configuration: { configured: false } };
    });
    await fixture.app.configuration();
    assert.equal(fixture.element('useSellerSpriteToggle').checked, enabled);
    assert.match(fixture.element('sellerSpriteStatusText').textContent, /未配置.*Amazon 可用/);
    assert.match(fixture.element('sellerSpriteSetupStatus').textContent, /正常使用 Amazon 模式/);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].options.method || 'GET', 'GET');
  }
});

test('restored task source is preserved rather than silently disabled when optional MCP is missing', async () => {
  const fixture = harness();
  fixture.app.restoreCriteria({ useSellerSprite: true });
  fixture.respond(async () => ({ configuration: { configured: false } }));
  await fixture.app.configuration();
  assert.equal(fixture.element('useSellerSpriteToggle').checked, true);
  fixture.app.resumeAmazon();
  assert.equal(fixture.calls.length, 1, 'Opening or restoring the page cannot start a business task');
});

test('historical business calls and verified task sales have distinct scopes; absent counters never become zero', () => {
  const fixture = harness();
  fixture.app.counts(24, 3);
  fixture.app.counts(null, null);
  fixture.app.counts(undefined, undefined);
  fixture.app.counts('', '');
  assert.equal(fixture.element('sellerSpriteCallCount').textContent, '历史商品调用 24 次');
  assert.match(fixture.element('sellerSpriteCallCount').title, /1 次调用可能查询多个 ASIN/);
  assert.match(fixture.element('sellerSpriteCallCount').title, /连接和工具清单检查不计入/);
  fixture.app.setProducts([apiProduct(), amazon(50), amazon(null),
    apiProduct({ marketplace: 'CA', sourceMarketplace: 'CA' })], { useSellerSprite: true });
  fixture.app.coverage();
  assert.match(fixture.element('sellerSpriteSalesCount').textContent, /当前任务月销量 1 个 ASIN/);
  assert.match(fixture.element('sellerSpriteSalesUnknown').textContent, /未知 2 个/);
  assert.equal(fixture.element('sellerSpriteCallCount').textContent, '历史商品调用 24 次');
  fixture.app.setProducts([apiProduct()], { useSellerSprite: false });
  fixture.app.coverage();
  assert.match(fixture.element('sellerSpriteSalesCount').textContent, /月销量 0 个 ASIN/);
});

test('program monitor coalesces read-only status requests and escapes event text', async () => {
  const fixture = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fixture.respond(async (url, options) => {
    assert.equal(url, '/api/monitor');
    assert.equal(options.method || 'GET', 'GET');
    await gate;
    return { enabled: true, intervals: { amazonMs: 900000, supplier1688Ms: 1800000 },
      checks: { amazon: { status: 'idle', lastCheckedAt: '2026-10-12T08:00:00Z' }, supplier1688: { status: 'needs_attention' } },
      events: [{ id: 'event-1', message: '<img src=x onerror=alert(1)>', createdAt: '2026-10-12T08:00:00Z' }] };
  });
  const first = fixture.app.monitor();
  const second = fixture.app.monitor();
  release();
  await Promise.all([first, second]);
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.element('localMonitorStatus').textContent, /需要处理/);
  assert.match(fixture.element('localMonitorFrequency').textContent, /Amazon 15 分钟；1688 30 分钟/);
  assert.match(fixture.element('localMonitorEvents').innerHTML, /&lt;img/);
  assert.equal(fixture.element('localMonitorEvents').innerHTML.includes('<img'), false);
  assert.equal(fixture.element('localMonitorEmpty').hidden, true);
  fixture.respond(async () => { throw new Error('synthetic unavailable'); });
  assert.equal(await fixture.app.monitor(), null);
  assert.match(fixture.element('localMonitorStatus').textContent, /暂时无法读取/);
  assert.equal(fixture.app.state().localMonitorState.events.length, 1);
});


for (const [extra, expected] of [
  [{ configured: true, enabled: false }, /尚未运行/],
  [{ configured: false, enabled: false }, /已关闭/],
  [{ errorCode: 'SYNTHETIC_START_FAILURE' }, /巡检服务异常/],
  [{ persistenceError: 'SYNTHETIC_SAVE_FAILURE' }, /巡检服务异常/],
]) {
  test(`monitor distinguishes disabled, stopped, and safe service failures: ${JSON.stringify(extra)}`, async () => {
    const fixture = harness();
    fixture.respond(async () => ({ enabled: true, configured: true,
      checks: { amazon: { status: 'idle' }, supplier1688: { status: 'waiting' } },
      message: 'raw upstream secret must not be rendered', ...extra }));
    await fixture.app.monitor();
    assert.match(fixture.element('localMonitorStatus').textContent, expected);
    const summary = fixture.element('localMonitorCheckSummary').textContent;
    assert.equal(summary.includes('raw upstream'), false);
    if (extra.errorCode) assert.match(summary, /未能启动，请检查本地服务/);
    if (extra.persistenceError) assert.match(summary, /状态未能保存，请检查本地服务/);
    if (extra.errorCode || extra.persistenceError) {
      assert.equal(fixture.element('localMonitorStatus').dataset.state, 'attention');
      assert.equal(summary.includes(extra.errorCode || extra.persistenceError), false);
    }
  });
}

test('degraded monitor checks stay visible as an actionable read failure rather than healthy', async () => {
  const fixture = harness();
  fixture.respond(async () => ({ enabled: true, configured: true,
    checks: { amazon: { status: 'degraded', hasActivity: true }, supplier1688: { status: 'waiting' } } }));
  await fixture.app.monitor();
  assert.match(fixture.element('localMonitorStatus').textContent, /需要处理/);
  assert.match(fixture.element('localMonitorCheckSummary').textContent, /Amazon：状态读取异常/);
  assert.equal(fixture.element('localMonitorStatus').dataset.state, 'attention');
});


for (const status of ['unavailable', 'degraded']) {
  for (const hasActivity of [false, true]) {
    test(`optional supplier ${status} requires attention only for an actual task: ${hasActivity}`, async () => {
      const fixture = harness();
      fixture.respond(async () => ({ enabled: true, configured: true,
        checks: { amazon: { status: 'running', hasActivity: true }, supplier1688: { status, hasActivity } }, events: [] }));
      await fixture.app.monitor();
      assert.equal(fixture.element('localMonitorStatus').dataset.state, hasActivity ? 'attention' : 'normal');
      assert.match(fixture.element('localMonitorStatus').textContent, hasActivity ? /需要处理/ : /独立巡检中/);
      if (!hasActivity) assert.match(fixture.element('localMonitorCheckSummary').textContent, /可选服务未启用.*无匹配任务/);
    });
  }
}

test('page heartbeat refreshes persisted business-call counters during long analyses using only local status endpoints', async () => {
  const fixture = harness({ enabled: true });
  let count = 5;
  fixture.respond(async (url, options) => {
    if (url === '/api/runtime/heartbeat') { assert.equal(options.method, 'POST'); return {}; }
    assert.equal(options.method || 'GET', 'GET');
    if (url === '/api/version') return { connected: false, toolCallCount: count, sessionToolCallCount: count };
    assert.equal(url, '/api/monitor');
    return { enabled: true, configured: true, checks: { amazon: { status: 'running' } }, events: [] };
  });
  await fixture.app.heartbeat();
  assert.equal(fixture.element('sellerSpriteCallCount').textContent, '历史商品调用 5 次');
  assert.equal(fixture.intervals.length, 1);
  assert.equal(fixture.intervals[0].ms, 30000);
  count = 12;
  await fixture.intervals[0].callback();
  assert.equal(fixture.element('sellerSpriteCallCount').textContent, '历史商品调用 12 次');
  assert.equal(fixture.element('useSellerSpriteToggle').checked, true);
  assert.equal(fixture.calls.length, 6);
  assert.equal(fixture.calls.some(call => call.url.includes('health') || call.url.includes('connect') || call.url.includes('analyze')), false);
});
