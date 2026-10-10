import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { CliError } from '../dist/io/errors.js';
import { readImageResultId, setVerifiedImageUpload, resolveImageSearchUploadInput, CURRENT_IMAGE_SEARCH_OFFER_METHODS } from '../dist/commands/image-search.js';
import { readSearchMtopRequestMeta, SEARCH_APP_ID, SEARCH_MTOP_API } from '../dist/session/search-mtop.js';

const imageSource = await readFile(new URL('../dist/commands/image-search.js', import.meta.url), 'utf8');
const recoverySource = await readFile(new URL('../dist/session/recovery.js', import.meta.url), 'utf8');
const locatorSource = await readFile(new URL('../dist/session/image-search-locators.js', import.meta.url), 'utf8');
const functionBlock = (source, first, next) => {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end).replace(/^export /gm, '');
};

function noRetryHarness(error, state) {
  let visits = 0;
  let created = 0;
  let closed = 0;
  const sleeps = [];
  const ctx = new EventEmitter();
  const pages = [];
  ctx.pages = () => pages;
  ctx.newPage = async () => {
    created += 1;
    const page = new EventEmitter();
    page.isClosed = () => Boolean(page.closed);
    page.close = async () => { page.closed = true; closed += 1; };
    pages.push(page);
    return page;
  };
  const context = vm.createContext({
    Error, CliError, info() {}, redactChallengeUrl: value => value,
    captureFailureArtifact: async () => ({}), detectPageState: async () => ({ kind: state }),
    sleep: async ms => { sleeps.push(ms); }, reportProgress: async () => {},
    readVerifiedImageUpload: async () => ({ buffer: Buffer.from('synthetic') }),
    executeImageSearch: async () => { visits += 1; throw error; },
  });
  const recovery = recoverySource.slice(recoverySource.indexOf('const MAX_TRACE_ITEMS')).replace(/^export /gm, '');
  const execute = functionBlock(imageSource, 'export async function execute(', 'export async function readVerifiedImageUpload(');
  const run = vm.runInContext(`${recovery}\n${execute}\nexecute`, context);
  return { run: () => run(ctx, { imagePath: 'synthetic', max: 40 }), sleeps,
    counts: () => ({ visits, created, closed }) };
}

for (const scenario of [
  { name: 'network failure', error: () => new Error('net::ERR_CONNECTION_RESET'), state: 'normal_1688_page', code: 'NETWORK_ERROR' },
  { name: 'rate limit', error: () => new CliError(9, 'RATE_LIMITED', 'HTTP 429'), state: 'rate_limited', code: 'RATE_LIMITED' },
  { name: 'risk challenge', error: () => new CliError(4, 'RISK_CONTROL', 'Manual verification required'), state: 'risk_challenge', code: 'RISK_CONTROL' },
  { name: 'missing element', error: () => new CliError(14, 'STABLE_LOCATOR_NOT_FOUND', 'Could not locate image search submit element'), state: 'normal_1688_page', code: 'STABLE_LOCATOR_NOT_FOUND' },
]) {
  test(`${scenario.name} exits the logical image-search task without a second visit or internal cooldown/retry`, async () => {
    const mock = noRetryHarness(scenario.error(), scenario.state);
    await assert.rejects(mock.run(), { code: scenario.code });
    assert.deepEqual(mock.counts(), { visits: 1, created: 1, closed: 1 });
    assert.deepEqual(mock.sleeps, []);
  });
}

const uploadUrl = 'https://s.1688.com/youyuan/index.htm';
const resultUrl = 'https://air.1688.com/kapp/1688-search/pc-image-search?imageId=123456&imageIdList=123456&tab=imageSearch';
function uploadHarness(mode) {
  const header = mode.startsWith('header-');
  const delayedNavigation = mode.endsWith('delayed-navigation');
  let currentUrl = uploadUrl;
  let time = 0;
  let blocked = false;
  let responseListenerReady = false;
  let resultDueAt = null;
  const counts = { navigations: 0, uploads: 0, clicks: 0, responsesCaptured: 0 };
  const page = new EventEmitter();
  page.url = () => currentUrl;
  page.isClosed = () => false;
  page.goto = async url => { counts.navigations += 1; currentUrl = url; };
  const emitStart = () => page.emit('request', { resourceType: () => 'xhr', method: () => 'GET',
    url: () => `https://h5api.m.1688.com/h5/${SEARCH_MTOP_API}/1.0/?data=${encodeURIComponent(JSON.stringify({ appId: SEARCH_APP_ID, params: { method: 'imageOfferSearchService', imageId: '123456' } }))}` });
  const finish = () => {
    currentUrl = resultUrl;
    if (responseListenerReady) counts.responsesCaptured += 1;
  };
  const performClick = async options => {
    counts.clicks += 1;
    emitStart();
    if (delayedNavigation) {
      // Model Playwright's separate post-click navigation wait: actionability
      // and the one click succeed, but navigation takes longer than 5000 ms.
      if (options.noWaitAfter !== true) throw new Error('click action done; scheduled navigation exceeded 5000 ms');
      resultDueAt = time + 6000;
    } else finish();
  };
  const form = { method: 'post', enctype: 'multipart/form-data', action: uploadUrl, elements: [] };
  const button = { tagName: 'BUTTON', type: 'submit', disabled: false, innerText: '搜索图片',
    getBoundingClientRect: () => ({ width: 100, height: 30 }) };
  const file = { files: [], disabled: false, form: mode.startsWith('legacy') || mode === 'late-start' ? form : null };
  form.elements.push(file, button);
  let previewSrc = '';
  let headerChecks = 0;
  const bounds = () => ({ width: 100, height: 30 });
  const preview = { getBoundingClientRect: bounds, complete: true, naturalWidth: 100, getAttribute: () => previewSrc };
  const headerButton = { getBoundingClientRect: bounds, textContent: '搜索图片', getAttribute: () => null };
  const panel = { getBoundingClientRect: bounds,
    querySelector: selector => selector === '.copy-image img' ? preview : { textContent: '已上传1张图片' },
    querySelectorAll: () => [headerButton],
  };
  page.evaluate = async (fn, args) => {
    if (args?.expectedPreviewSrc) {
      headerChecks += 1;
      if (mode === 'header-late-auto' && headerChecks === 2) emitStart();
      if (mode === 'header-late-risk' && headerChecks === 2) blocked = true;
    }
    return vm.runInNewContext(`(${fn.toString()})(args)`, {
      args, document: { querySelectorAll: selector => selector.includes('.copy-image-container') ? [panel] : [file] },
      location: { href: currentUrl }, URL, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    });
  };
  page.locator = selector => ({
    count: async () => selector.startsWith('#pc-home2024-search-tab') ? (header ? 1 : 0) : 1,
    isDisabled: async () => false,
    click: async options => {
      assert.ok(header && selector.endsWith('.search-btn'));
      await performClick(options);
    },
    setInputFiles: async payload => {
      counts.uploads += 1;
      assert.equal(responseListenerReady, true, 'Offer response capture must be active before the file-input change.');
      file.files = [{}];
      if (mode === 'network-failure') throw new Error('net::ERR_CONNECTION_RESET');
      if (mode === 'auto') { emitStart(); finish(); }
      if (mode === 'slow-result') emitStart();
      if (mode === 'risk') blocked = true;
      if (header) {
        previewSrc = `data:${payload.mimeType};base64,${payload.buffer.toString('base64')}`;
        if (mode === 'header-stale-preview') previewSrc = 'data:image/png;base64,c3RhbGU=';
        if (mode === 'header-background' || mode === 'header-stale-preview') {
          page.emit('request', { resourceType: () => 'xhr', method: () => 'GET', url: () => 'https://www.1688.com/background' });
          page.emit('request', { resourceType: () => 'xhr', method: () => 'POST', url: () => 'https://www.1688.com/image-upload' });
        }
        if (mode === 'header-auto') { emitStart(); finish(); }
        if (mode === 'header-risk') blocked = true;
      }
    },
  });
  const context = vm.createContext({
    CliError, Error, URL, info() {}, Date: { now: () => time },
    UPLOAD_PAGE: uploadUrl, setVerifiedImageUpload, readImageResultId,
    readSearchMtopRequestMeta, SEARCH_APP_ID, CURRENT_IMAGE_SEARCH_OFFER_METHODS,
    reportProgress: async () => {},
    delay: async ms => {
      time += ms;
      if (resultDueAt !== null && time >= resultDueAt) { resultDueAt = null; finish(); }
    },
    waitPastImageSearchRiskControl: async () => {},
    detectImageSearchRiskControl: async () => ({ blocked }),
    matchesImageOfferRequest: () => true,
    captureSearchOffersForAction: async (_options, action) => {
      responseListenerReady = true;
      try {
        const actionResult = await action();
        return { actionResult, status: 'captured', offers: [{ offerId: 'fixture-offer' }] };
      } finally { responseListenerReady = false; }
    },
    clickImageSearchButton: async (_page, { shouldClick }) => {
      if (mode === 'late-start') { emitStart(); finish(); }
      if (!(await shouldClick())) return false;
      counts.clicks += 1;
      emitStart();
      finish();
      return true;
    },
    waitForImageResultOrRiskControl: async () => {
      if (mode === 'risk' || mode === 'header-risk' || mode === 'header-late-risk') throw new CliError(4, 'RISK_CONTROL', 'Manual verification required');
      if (mode === 'slow-result' || mode === 'header-late-auto') finish();
      assert.equal(currentUrl, resultUrl);
    },
  });
  if (mode === 'legacy-delayed-navigation') {
    const legacyContext = vm.createContext({
      CliError, locatorCandidateToDebugString: () => 'fixture',
      findClickable: async () => ({ click: performClick }),
    });
    const legacySource = locatorSource.slice(locatorSource.indexOf('export async function clickImageSearchButton(')).replace(/^export /gm, '');
    context.clickImageSearchButton = vm.runInContext(`${legacySource}\nclickImageSearchButton`, legacyContext);
  }
  const block = functionBlock(imageSource, 'async function executeImageSearch(', 'export function readImageResultId(');
  const businessWait = delayedNavigation
    ? functionBlock(imageSource, 'async function waitForImageResultOrRiskControl(', 'export async function detectImageSearchRiskControl(') : '';
  const run = vm.runInContext(`${block}\n${businessWait}\nuploadAndCaptureOffers`, context);
  return { run: () => run(page, { max: 40 }, { name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('fixture') }), counts, page, elapsed: () => time };
}

test('automatic upload/search is captured immediately and never receives an extra submit click', async () => {
  const mock = uploadHarness('auto');
  const result = await mock.run();
  assert.equal(result.imageId, '123456');
  assert.deepEqual(mock.counts, { navigations: 1, uploads: 1, clicks: 0, responsesCaptured: 1 });
  assert.equal(mock.page.listenerCount('request'), 0);
});

test('a selected file in an explicit legacy multipart search form receives exactly one submit click', async () => {
  const mock = uploadHarness('legacy');
  await mock.run();
  assert.deepEqual(mock.counts, { navigations: 1, uploads: 1, clicks: 1, responsesCaptured: 1 });
});

test('a slow response after the first upload request does not cause a second submission', async () => {
  const mock = uploadHarness('slow-result');
  await mock.run();
  assert.equal(mock.counts.uploads, 1);
  assert.equal(mock.counts.clicks, 0);
});

test('automatic submission observed while locating a legacy button cancels that click', async () => {
  const mock = uploadHarness('late-start');
  await mock.run();
  assert.equal(mock.counts.uploads, 1);
  assert.equal(mock.counts.clicks, 0);
});

for (const [mode, code] of [['ambiguous', 'IMAGE_SUBMISSION_UNCONFIRMED'], ['risk', 'RISK_CONTROL']]) {
  test(`${mode} upload state stops without clicking, re-uploading, or visiting again`, async () => {
    const mock = uploadHarness(mode);
    await assert.rejects(mock.run(), { code });
    assert.deepEqual(mock.counts, { navigations: 1, uploads: 1, clicks: 0, responsesCaptured: 0 });
    assert.equal(mock.page.listenerCount('request'), 0);
  });
}

test('an upload transport error removes listeners and never performs a fallback click', async () => {
  const mock = uploadHarness('network-failure');
  await assert.rejects(mock.run(), /ERR_CONNECTION_RESET/);
  assert.deepEqual(mock.counts, { navigations: 1, uploads: 1, clicks: 0, responsesCaptured: 0 });
  assert.equal(mock.page.listenerCount('request'), 0);
});

test('the actual submit locator honors the final no-click guard', async () => {
  let clicks = 0;
  const context = vm.createContext({
    CliError, locatorCandidateToDebugString: () => 'fixture',
    findClickable: async () => ({ click: async () => { clicks += 1; } }),
  });
  const block = locatorSource.slice(locatorSource.indexOf('export async function clickImageSearchButton(')).replace(/^export /gm, '');
  const click = vm.runInContext(`${block}\nclickImageSearchButton`, context);
  assert.equal(await click({}, { shouldClick: async () => false }), false);
  assert.equal(clicks, 0);
  assert.equal(await click({}, { shouldClick: async () => true }), true);
  assert.equal(clicks, 1);
});

test('the recorded React preview requires exactly one search click despite background GET and image-upload POST requests', async () => {
  const mock = uploadHarness('header-background');
  await mock.run();
  assert.deepEqual(mock.counts, { navigations: 1, uploads: 1, clicks: 1, responsesCaptured: 1 });
  assert.equal(mock.page.listenerCount('request'), 0);
});

test('the header preview for a different image never authorizes a search click or another upload', async () => {
  const mock = uploadHarness('header-stale-preview');
  await assert.rejects(mock.run(), { code: 'IMAGE_SUBMISSION_UNCONFIRMED' });
  assert.deepEqual(mock.counts, { navigations: 1, uploads: 1, clicks: 0, responsesCaptured: 0 });
});

for (const mode of ['header-auto', 'header-late-auto']) {
  test(`${mode} search starting before the final panel guard suppresses the explicit click`, async () => {
    const mock = uploadHarness(mode);
    await mock.run();
    assert.equal(mock.counts.uploads, 1);
    assert.equal(mock.counts.clicks, 0);
  });
}

for (const mode of ['header-risk', 'header-late-risk']) {
  test(`${mode} in the header preview waits for manual verification without clicking search`, async () => {
    const mock = uploadHarness(mode);
    await assert.rejects(mock.run(), { code: 'RISK_CONTROL' });
    assert.equal(mock.counts.uploads, 1);
    assert.equal(mock.counts.clicks, 0);
  });
}

test('the HTML-proven header input wins over unrelated file inputs without relying on accept=image', async () => {
  const selected = [];
  const page = { locator: selector => ({ selector, count: async () => selector.startsWith('#pc-home2024-search-tab') ? 1 : 3,
    isDisabled: async () => false, setInputFiles: async () => selected.push(selector) }) };
  const input = await resolveImageSearchUploadInput(page);
  assert.match(input.selector, /#img-search-upload/);
  const uploaded = await setVerifiedImageUpload(page, { name: 'fixture.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fixture') });
  assert.equal(uploaded.kind, 'header_image_search');
  assert.equal(selected.length, 1);
});

test('multiple unscoped image inputs fail before setting any file instead of choosing the first', async () => {
  const page = { locator: selector => ({ count: async () => selector.startsWith('#pc-home2024-search-tab') ? 0 : 2 }) };
  await assert.rejects(resolveImageSearchUploadInput(page), { code: 'IMAGE_UPLOAD_CONTROL_AMBIGUOUS' });
});

test('a disabled known header input is not considered ready', async () => {
  const page = { locator: () => ({ count: async () => 1, isDisabled: async () => true }) };
  assert.equal(await resolveImageSearchUploadInput(page), null);
});

for (const mode of ['header-delayed-navigation', 'legacy-delayed-navigation']) {
  test(`${mode} keeps the single click and lets the business-result wait accept a navigation lasting over five seconds`, async () => {
    const mock = uploadHarness(mode);
    const result = await mock.run();
    assert.equal(result.imageId, '123456');
    assert.deepEqual(mock.counts, { navigations: 1, uploads: 1, clicks: 1, responsesCaptured: 1 });
    assert.ok(mock.elapsed() >= 6000);
    assert.equal(mock.page.listenerCount('request'), 0);
  });
}
