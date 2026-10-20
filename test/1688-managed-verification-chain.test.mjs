import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

// Override the root to run the same isolated regression against the deployed
// sibling CLI; no browser,
// account state, business file, or network connection is opened by this test.
const runtimeRoot = process.env.SCOUT_1688_VERIFICATION_TEST_ROOT
  ?? path.resolve(import.meta.dirname, '../1688-dependencies/1688-image-finder');
const runtimeUrl = relative => pathToFileURL(path.join(runtimeRoot, relative));
const [{ CliError }, { parseIdentity }, mtop, { withTimeout }, { startManagedImageSearchEvidence }] = await Promise.all([
  import(runtimeUrl('dist/io/errors.js')),
  import(runtimeUrl('dist/auth/cookies.js')),
  import(runtimeUrl('dist/session/search-mtop.js')),
  import(runtimeUrl('dist/session/wait.js')),
  import(runtimeUrl('dist/session/image-search-verification-evidence.js')),
]);
const [loginSource, verifySource, imageSource] = await Promise.all([
  readFile(runtimeUrl('dist/commands/login.js'), 'utf8'),
  readFile(runtimeUrl('dist/auth/verify.js'), 'utf8'),
  readFile(runtimeUrl('dist/commands/image-search.js'), 'utf8'),
]);
const removeImportsAndExports = source => source
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replace(/^export /gm, '');
function block(source, first, next) {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, `Missing production function block: ${first}`);
  return source.slice(start, end);
}
const productionSource = [
  removeImportsAndExports(loginSource),
  removeImportsAndExports(verifySource),
  removeImportsAndExports(block(imageSource, 'export async function submitImageSearchOnce(', 'async function waitPastImageSearchRiskControl(')),
].join('\n');
const uploadUrl = 'https://s.1688.com/youyuan/index.htm';
const resultUrl = 'https://air.1688.com/kapp/1688-search/pc-image-search?imageId=123456&imageIdList=123456&tab=imageSearch';
const normal = url => ({ kind: 'normal_1688_page', url });
const identityCookie = { name: 'unb', value: 'fixture-member', domain: '.1688.com', path: '/', expires: 86400, secure: true, httpOnly: true, sameSite: 'None' };
const requestData = { appId: mtop.SEARCH_APP_ID, params: {
  method: 'imageOfferSearchService', imageId: '123456', imageIdList: '123456',
  beginPage: 1, pageSize: 60, searchScene: 'pcImageSearch', appName: 'pctusou', tab: 'imageSearch',
} };
const offerResponseText = JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { data: {
  OFFER: { items: [{ data: { offerId: '987654321012', title: 'Fixture matching product', priceInfo: { price: '5.00' } } }] },
} } });

function harness({ workspaceOutcomes = ['ready'], businessResponse = true, resultState = 'normal_1688_page', reopenedCookies,
  responseText = offerResponseText, responseStatus = 200, requestParams = {}, requestHost = 'h5api.m.1688.com',
  sampleStates, responseSamples = [1], responseTexts, responseStatuses, freshRequestAtResponse = false, initialCookies,
  responseDuringUpload = false, afterUploadCookies,
} = {}) {
  let now = 0;
  let uploaded = false;
  let afterSamples = 0;
  let closed = false;
  let state = normal(uploadUrl);
  let probeCount = 0;
  const calls = { uploads: 0, probes: [], stages: [], states: [], emitted: [], artifacts: [], events: [] };
  const cookies = initialCookies ?? [{ ...identityCookie }];
  const actualRequestData = { ...requestData, params: { ...requestData.params, ...requestParams } };
  const makeRequest = () => ({ url: () => `https://${requestHost}/h5/${mtop.SEARCH_MTOP_API}/1.0/?data=${encodeURIComponent(JSON.stringify(actualRequestData))}`, postData: () => null, resourceType: () => 'xhr', method: () => 'POST' });
  let request = makeRequest();
  const makeResponse = currentRequest => ({ url: currentRequest.url, request: () => currentRequest,
    text: async () => responseTexts?.[responseSamples.indexOf(afterSamples)] ?? responseText,
    status: () => responseStatuses?.[responseSamples.indexOf(afterSamples)] ?? responseStatus });
  const page = new EventEmitter();
  page.url = () => state.url;
  page.isClosed = () => closed;
  page.bringToFront = async () => {};
  page.goto = async url => { state = normal(url); };
  const fileInput = { tagName: 'INPUT', type: 'file', accept: 'image/*', disabled: false, hidden: false,
    getAttribute: name => ({ type: 'file', accept: 'image/*' })[name] ?? null,
    getBoundingClientRect: () => ({ width: 100, height: 30 }), getClientRects: () => [{}] };
  const fixtureDocument = {
    querySelector: () => null,
    querySelectorAll: selector => selector === 'input[type="file"]' ? [fileInput] : [],
  };
  page.evaluate = async callback => callback();
  const makeProbe = () => {
    const outcome = workspaceOutcomes[Math.min(probeCount++, workspaceOutcomes.length - 1)];
    let url = 'about:blank';
    const probe = {
      fixtureProbe: true,
      fixtureState: normal('https://work.1688.com/'),
      url: () => url,
      goto: async requestedUrl => {
        calls.probes.push({ requestedUrl, outcome });
        if (outcome === 'timeout') throw new Error('Fixture workspace timeout');
        url = outcome === 'redirect' ? 'https://www.1688.com/' : 'https://work.1688.com/';
        probe.fixtureState = { kind: outcome === 'risk' ? 'risk_challenge' : outcome === 'login' ? 'not_logged_in' : 'normal_1688_page', url };
        return { status: () => 200 };
      },
      close: async () => { calls.events.push('probe-closed'); },
    };
    return probe;
  };
  const makeContext = (persisted = false) => ({
    pages: () => persisted ? [] : [page],
    cookies: async () => persisted && reopenedCookies ? reopenedCookies : cookies,
    addCookies: async values => { cookies.splice(0, cookies.length, ...values); calls.events.push('persist-cookies'); },
    newPage: async () => makeProbe(),
    close: async () => { calls.events.push('persisted-context-closed'); },
  });
  const context = makeContext();
  const advance = async ms => {
    now += ms;
    if (!uploaded) return;
    afterSamples++;
    if (afterSamples === 1 && afterUploadCookies) cookies.splice(0, cookies.length, ...afterUploadCookies);
    state = sampleStates?.[Math.min(afterSamples - 1, sampleStates.length - 1)] ?? { kind: resultState, url: resultUrl };
    if (businessResponse && responseSamples.includes(afterSamples)) {
      if (freshRequestAtResponse) { request = makeRequest(); page.emit('request', request); }
      page.emit('response', makeResponse(request));
      calls.events.push('current-image-offer-response');
      await Promise.resolve();
    }
  };
  class FixtureDate extends Date { static now() { return now; } }
  const mock = vm.createContext({
    URL, URLSearchParams, Buffer, Error, CliError, Date: FixtureDate, parseIdentity,
    withTimeout, ...mtop, startManagedImageSearchEvidence, CURRENT_IMAGE_SEARCH_OFFER_METHODS: ['getImageSearchPreResult', 'imageOfferSearchService'],
    document: fixtureDocument, getComputedStyle: () => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto' }),
    process: { env: { BB1688_LOGIN_ATTEMPT: 'fixture-attempt', BB1688_LOGIN_TOKEN: 'fixture-token' },
      stderr: { write: value => calls.stages.push(value.trim().replace('[image-search-verification] ', '')) } },
    fixtureReadUpload: async () => ({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('fixture') }),
    fixtureBrokerControl: () => ({}), fixtureReady: async () => {}, fixtureCancel: async () => {},
    fixtureCancellation: async (_control, operation) => operation(),
    defaultProfileName: value => value ?? 'default', isJson: () => true, info() {},
    nowIso: () => '2026-10-15T01:40:00.000Z',
    writeState: async value => calls.states.push(value), emit: value => calls.emitted.push(value.data),
    withNativeVisibleEdge: async (_options, visible, persisted) => {
      let identity;
      try { identity = await visible(context); }
      finally { closed = true; calls.events.push('native-context-closed'); }
      calls.events.push('reopen-persistent-profile');
      return persisted(identity);
    },
    launchEdgeContext: async () => makeContext(true),
    captureFailureArtifact: async (_context, _metadata, error) => { calls.artifacts.push({ code: error.code, message: error.message }); return {}; },
    detectPageState: async candidate => candidate.fixtureProbe ? candidate.fixtureState : state,
    detectImageSearchRiskControl: async () => ({ blocked: state.kind === 'risk_challenge' }),
    resolveImageSearchUploadInput: async () => fileInput,
    setVerifiedImageUpload: async () => {
      uploaded = true; calls.uploads++; page.emit('request', request);
      if (responseDuringUpload) page.emit('response', makeResponse(request));
    },
    clickImageSearchButton: async () => { throw new Error('Unexpected duplicate image submission'); },
    sleep: advance, delay: advance,
  });
  const run = vm.runInContext(`${productionSource}\n
    readBrokerManagedImageSearchUpload = fixtureReadUpload;
    requireBrokerLoginControl = fixtureBrokerControl;
    writeBrokerEdgeReadySignal = fixtureReady;
    throwIfBrokerLoginCanceled = fixtureCancel;
    runWithBrokerLoginCancellation = fixtureCancellation;
    run;`, mock);
  return { calls, page, run: () => run({ purpose: 'image_search', timeout: '30' }),
    ordinaryPersistedCheck: () => vm.runInContext('verifyPersistedContext', mock)(context, parseIdentity(cookies)),
  };
}

test('chain control: real managed business proof, persistence and reopened identity succeed without workspace traffic', async () => {
  const fixture = harness();
  await fixture.run();
  assert.equal(fixture.calls.uploads, 1);
  assert.equal(fixture.calls.probes.length, 0);
  assert.equal(fixture.calls.states.length, 1);
  assert.equal(fixture.calls.emitted[0].ok, true);
  assert.ok(fixture.calls.stages.includes('verified_result'));
  assert.equal(fixture.page.listenerCount('request'), 0);
  assert.equal(fixture.page.listenerCount('response'), 0);
  assert.equal(fixture.page.listenerCount('close'), 0);
});

test('current image offer success must not become last-window-incomplete solely because unrelated workspace redirects', async () => {
  const fixture = harness({ workspaceOutcomes: ['redirect'] });
  let failure;
  try { await fixture.run(); } catch (error) { failure = error; }
  assert.ok(fixture.calls.events.includes('current-image-offer-response'));
  assert.equal(fixture.calls.uploads, 1);
  assert.equal(failure, undefined,
    `Current image result was delivered but verification reported ${failure?.code}: ${failure?.message}`);
  assert.equal(fixture.calls.emitted[0].ok, true);
  assert.equal(fixture.calls.states.length, 1);
});

test('reopened persistence check must not invalidate proven image search solely because workspace redirects', async () => {
  const fixture = harness({ workspaceOutcomes: ['ready', 'redirect'] });
  let failure;
  try { await fixture.run(); } catch (error) { failure = error; }
  assert.ok(fixture.calls.events.includes('reopen-persistent-profile'));
  assert.equal(failure, undefined,
    `Image search was verified before close, but reopened profile reported ${failure?.code}: ${failure?.message}`);
  assert.equal(fixture.calls.emitted[0].ok, true);
});

test('a stable result URL without a successful matching offer response is not sufficient proof', async () => {
  const fixture = harness({ businessResponse: false });
  await assert.rejects(fixture.run());
  assert.equal(fixture.calls.states.length, 0);
  assert.equal(fixture.calls.emitted.length, 0);
});

for (const [name, options, code] of [
  ['wrong image ID', { requestParams: { imageId: '654321', imageIdList: '654321' } }, 'IMAGE_SEARCH_RESULT_TIMEOUT'],
  ['wrong request method', { requestParams: { method: 'unrelatedSearch' } }, 'IMAGE_SEARCH_RESULT_TIMEOUT'],
  ['wrong business page size', { requestParams: { pageSize: 20 } }, 'IMAGE_SEARCH_RESULT_TIMEOUT'],
  ['untrusted response host', { requestHost: 'example.test' }, 'IMAGE_SEARCH_RESULT_TIMEOUT'],
  ['failed response with product data', { responseText: offerResponseText.replace('SUCCESS::调用成功', 'FAIL_SYS_SERVICE::failed') }, 'IMAGE_SEARCH_RESULT_TIMEOUT'],
  ['service fallback response with product data', { responseText: offerResponseText.replace('Fixture matching product', 'service_fail#synthetic') }, 'IMAGE_SEARCH_RESULT_TIMEOUT'],
  ['response without SUCCESS', { responseText: JSON.stringify({ data: { data: { OFFER: { items: [{ data: { offerId: '987654321012' } }] } } } }) }, 'IMAGE_SEARCH_RESULT_TIMEOUT'],
  ['empty successful response', { responseText: JSON.stringify({ ret: ['SUCCESS::ok'], data: { data: { OFFER: { items: [] } } } }) }, 'IMAGE_SEARCH_RESULT_TIMEOUT'],
  ['server error', { responseStatus: 500 }, 'IMAGE_SEARCH_RESULT_TIMEOUT'],
  ['rate limit response', { responseStatus: 429 }, 'RATE_LIMITED'],
  ['expired login response', { responseText: offerResponseText.replace('SUCCESS::调用成功', 'FAIL_SYS_SESSION_EXPIRED::expired') }, 'NOT_LOGGED_IN'],
  ['risk response', { responseText: offerResponseText.replace('SUCCESS::调用成功', 'FAIL_SYS_USER_VALIDATE::captcha') }, 'RISK_CONTROL'],
]) {
  test(`${name} cannot publish managed verification success`, async () => {
    const fixture = harness(options);
    await assert.rejects(fixture.run(), error => error.code === code);
    assert.equal(fixture.calls.states.length, 0);
    assert.equal(fixture.calls.emitted.length, 0);
    assert.equal(fixture.page.listenerCount('request'), 0);
    assert.equal(fixture.page.listenerCount('response'), 0);
    assert.equal(fixture.page.listenerCount('close'), 0);
  });
}

test('a challenge invalidates successful evidence obtained before the challenge', async () => {
  const fixture = harness({ sampleStates: [normal(resultUrl), { kind: 'risk_challenge', url: resultUrl }, normal(resultUrl)] });
  await assert.rejects(fixture.run(), error => error.code === 'IMAGE_SEARCH_RESULT_TIMEOUT');
  assert.equal(fixture.calls.states.length, 0);
  assert.equal(fixture.calls.uploads, 1);
});

test('a fresh matching response after a user challenge proves the same single upload', async () => {
  const fixture = harness({ sampleStates: [normal(resultUrl), { kind: 'risk_challenge', url: resultUrl }, normal(resultUrl)],
    responseSamples: [1, 3], freshRequestAtResponse: true });
  await fixture.run();
  assert.equal(fixture.calls.uploads, 1);
  assert.equal(fixture.calls.probes.length, 0);
  assert.equal(fixture.calls.states.length, 1);
});

for (const tokenCode of ['FAIL_SYS_TOKEN_EXPIRED', 'FAIL_SYS_TOKEN_EMPTY']) {
  test(`${tokenCode} can refresh into a genuine successful response without another upload`, async () => {
    const fixture = harness({ responseSamples: [1, 2], freshRequestAtResponse: true,
      responseTexts: [JSON.stringify({ ret: [`${tokenCode}::refresh`] }), offerResponseText] });
    await fixture.run();
    assert.equal(fixture.calls.uploads, 1);
    assert.equal(fixture.calls.probes.length, 0);
    assert.equal(fixture.calls.states.length, 1);
  });
}

for (const [name, responseTexts, responseStatuses] of [
  ['MTOP challenge', [JSON.stringify({ ret: ['FAIL_SYS_USER_VALIDATE::captcha'] }), offerResponseText], [200, 200]],
  ['HTTP 403', [offerResponseText, offerResponseText], [403, 200]],
]) {
  test(`${name} arriving before the challenge UI keeps the same window open for manual completion`, async () => {
    const fixture = harness({ sampleStates: [normal(resultUrl), { kind: 'risk_challenge', url: resultUrl }, normal(resultUrl)],
      responseSamples: [1, 3], responseTexts, responseStatuses, freshRequestAtResponse: true });
    await fixture.run();
    assert.equal(fixture.calls.uploads, 1);
    assert.equal(fixture.calls.states.length, 1);
    assert.equal(fixture.calls.probes.length, 0);
    assert.ok(fixture.calls.stages.includes('waiting_manual_verification'));
    assert.deepEqual(fixture.calls.artifacts, []);
  });
}

test('responses observed while a challenge remains visible are not retained after it clears', async () => {
  const fixture = harness({ sampleStates: [
    { kind: 'risk_challenge', url: resultUrl }, { kind: 'risk_challenge', url: resultUrl }, normal(resultUrl),
  ], responseSamples: [2], freshRequestAtResponse: true });
  await assert.rejects(fixture.run(), error => error.code === 'IMAGE_SEARCH_RESULT_TIMEOUT');
  assert.equal(fixture.calls.states.length, 0);
});

for (const [name, reopenedCookies, code] of [
  ['missing identity', [], 'LOGIN_INCOMPLETE'],
  ['session-only identity', [{ ...identityCookie, expires: -1 }], 'LOGIN_COOKIE_NOT_PERSISTED'],
  ['conflicting identities', [{ ...identityCookie }, { ...identityCookie, value: 'other' }], 'LOGIN_COOKIE_CONFLICT'],
]) {
  test(`reopened profile rejects ${name}`, async () => {
    const fixture = harness({ reopenedCookies });
    await assert.rejects(fixture.run(), error => error.code === code);
    assert.equal(fixture.calls.states.length, 0);
  });
}

test('ordinary login persistence still requires the protected workspace online check', async () => {
  const fixture = harness({ workspaceOutcomes: ['redirect'] });
  await assert.rejects(fixture.ordinaryPersistedCheck(), error => error.code === 'LOGIN_ONLINE_VERIFICATION_FAILED');
  assert.equal(fixture.calls.probes.length, 1);
  assert.equal(fixture.calls.states.length, 0);
});

test('matching response may arrive before the new result URL without being lost', async () => {
  const fixture = harness({ responseDuringUpload: true, responseSamples: [] });
  await fixture.run();
  assert.equal(fixture.calls.states.length, 1);
  assert.equal(fixture.calls.uploads, 1);
  assert.equal(fixture.calls.probes.length, 0);
});

test('the account cannot change between upload and matching result', async () => {
  const fixture = harness({ afterUploadCookies: [{ ...identityCookie, value: 'changed-after-upload' }] });
  await assert.rejects(fixture.run(), error => error.code === 'LOGIN_IDENTITY_CHANGED');
  assert.equal(fixture.calls.states.length, 0);
});

test('challenge reset rejects in-flight reads and responses whose requests predate the capture', async () => {
  const matchesImageOfferRequest = vm.runInNewContext(
    removeImportsAndExports(block(imageSource, 'export function readImageResultId(', 'async function waitPastImageSearchRiskControl('))
      + '\nmatchesImageOfferRequest',
    { URL, SEARCH_APP_ID: mtop.SEARCH_APP_ID, CURRENT_IMAGE_SEARCH_OFFER_METHODS: ['getImageSearchPreResult', 'imageOfferSearchService'] },
  );
  const page = new EventEmitter();
  const proof = startManagedImageSearchEvidence(page, { previousImageId: null, matchesImageOfferRequest });
  const makeRequest = () => ({ url: () => `https://h5api.m.1688.com/h5/${mtop.SEARCH_MTOP_API}/1.0/?data=${encodeURIComponent(JSON.stringify(requestData))}`, postData: () => null });
  const staleRequest = makeRequest();
  const emitResponse = (request, text) => page.emit('response', { request: () => request, url: request.url, status: () => 200, text });
  emitResponse(staleRequest, async () => offerResponseText);
  await Promise.resolve();
  assert.equal(proof.forImage('123456'), undefined);
  let release;
  const pendingText = new Promise(resolve => { release = resolve; });
  page.emit('request', staleRequest);
  emitResponse(staleRequest, () => pendingText);
  proof.reset();
  release(offerResponseText);
  await Promise.resolve();
  assert.equal(proof.forImage('123456'), undefined);
  emitResponse(staleRequest, async () => offerResponseText);
  await Promise.resolve();
  assert.equal(proof.forImage('123456'), undefined);
  const freshRequest = makeRequest();
  page.emit('request', freshRequest);
  emitResponse(freshRequest, async () => offerResponseText);
  await Promise.resolve();
  assert.equal(proof.forImage('123456')?.offerCount, 1);
  proof.dispose();
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('close'), 0);
});

test('reopened profile must preserve the verified account identity', async () => {
  const fixture = harness({ reopenedCookies: [{ ...identityCookie, value: 'different-fixture-member' }] });
  await assert.rejects(fixture.run(), error => error.code === 'LOGIN_IDENTITY_CHANGED');
  assert.equal(fixture.calls.states.length, 0);
  assert.equal(fixture.calls.emitted.length, 0);
});
