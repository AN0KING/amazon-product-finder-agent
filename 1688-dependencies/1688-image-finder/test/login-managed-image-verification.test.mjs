import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { CliError } from '../dist/io/errors.js';
import { CURRENT_IMAGE_SEARCH_OFFER_METHODS, readImageResultId } from '../dist/commands/image-search.js';
import { readSearchMtopRequestMeta, SEARCH_APP_ID, SEARCH_MTOP_API } from '../dist/session/search-mtop.js';
import { withTimeout } from '../dist/session/wait.js';

const loginSource = await readFile(new URL('../dist/commands/login.js', import.meta.url), 'utf8');
const imageSource = await readFile(new URL('../dist/commands/image-search.js', import.meta.url), 'utf8');
const block = (source, first, next) => {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end).replace(/^export /gm, '');
};
const source = [
  block(loginSource, "const LOGIN_URL =", 'async function readBrokerManagedImageSearchUpload('),
  block(loginSource, 'async function completeManagedImageSearchVerification(', 'async function waitForImageSearchVerification('),
  block(loginSource, 'function isImageSearchRiskUrl(', 'async function verifyPersistedContext('),
  block(imageSource, 'export async function submitImageSearchOnce(', 'export function readImageResultId('),
].join('\n');
const uploadUrl = 'https://s.1688.com/youyuan/index.htm';
const legacyUploadUrl = 'https://s.1688.com/selloffer/offer_search.htm';
const resultUrl = id => `https://air.1688.com/kapp/1688-search/pc-image-search?imageId=${id}&imageIdList=${id}&tab=imageSearch`;
const normal = url => ({ kind: 'normal_1688_page', url });
const result = normal(resultUrl('123456'));
const risk = { kind: 'risk_challenge', url: 'https://s.1688.com/_____tmd_____/punish?x5secdata=synthetic' };
const repeat = (value, count) => Array.from({ length: count }, () => value);
const verificationStages = new Set([
  'waiting_upload_page', 'upload_control_ready', 'image_selected_waiting_result',
  'waiting_manual_verification', 'verified_result',
]);
const domElement = (tagName, values = {}) => {
  const attributes = { ...values.attributes };
  const element = {
    tagName, type: tagName === 'INPUT' ? 'file' : undefined,
    disabled: false, hidden: false, isConnected: true,
    accept: tagName === 'INPUT' ? 'image/*' : undefined,
    textContent: '', innerText: '',
    getAttribute: name => attributes[name] ?? element[name] ?? null,
    hasAttribute: name => attributes[name] !== undefined,
    getBoundingClientRect: () => ({ width: values.visible === false ? 0 : 100, height: values.visible === false ? 0 : 30 }),
    getClientRects: () => values.visible === false ? [] : [{ width: 100, height: 30 }],
    ...values,
  };
  return element;
};

// Run the real CLI entry, completion branch, managed verifier and shared single
// submission helper. All browser, clock, identity and persistence adapters are
// in-memory mocks: these tests cannot launch Edge or contact 1688.
function harness({
  before = [normal(uploadUrl)], after = [result], managed = true, timeout = '30',
  artifactResult = {}, artifactError = null, artifactBarrier = null, uploadError = null,
  inputResolutionError = null, inputResolutionBarrier = null,
} = {}) {
  let time = 0;
  let beforeSamples = 0;
  let afterSamples = 0;
  let state = before[0];
  let contextClosed = false;
  let notifyArtifactStarted;
  const artifactStarted = new Promise(resolve => { notifyArtifactStarted = resolve; });
  const identity = { memberId: 'fixture-member', nick: 'fixture-account' };
  const upload = { name: 'same-task-image.png', mimeType: 'image/png', buffer: Buffer.from('synthetic-verified-image') };
  const events = [];
  const calls = { native: 0, manual: 0, uploads: 0, pageProbes: 0, inputResolutions: 0, navigation: [], finalStates: [], emitted: [], launchUrls: [], stageLogs: [], stageEvents: [], artifacts: [] };
  const page = new EventEmitter();
  page.url = () => state.url;
  page.isClosed = () => contextClosed || state.closed === true;
  page.bringToFront = async () => { events.push('front'); };
  page.goto = async url => { calls.navigation.push(url); state = normal(url); };
  page.evaluate = async probe => {
    calls.pageProbes += 1;
    const inputs = (state.inputs ?? [{}]).map(values => domElement('INPUT', values));
    const buttons = (state.buttons ?? []).map(values => domElement('BUTTON', values));
    mock.document = {
      querySelector: selector => {
        assert.equal(selector, 'link[href*="/1688-search/pc-image-search/"]');
        return state.marker === true ? domElement('LINK') : null;
      },
      querySelectorAll: selector => {
        if (selector === 'input[type="file"]') return inputs;
        assert.match(selector, /button|image-upload/);
        return buttons;
      },
    };
    return probe();
  };
  const context = {
    pages: () => [page],
    newPage: async () => { throw new Error('The native image-search page must be reused.'); },
    cookies: async () => [{ name: 'fixture-logged-in', value: 'yes' }],
  };
  const advance = async ms => {
    time += ms;
    if (calls.uploads) {
      state = after[Math.min(afterSamples, after.length - 1)];
      afterSamples += 1;
    } else {
      state = before[Math.min(beforeSamples, before.length - 1)];
      beforeSamples += 1;
    }
  };
  const mock = vm.createContext({
    URL, Error, CliError, Date: { now: () => time }, readImageResultId, withTimeout,
    readSearchMtopRequestMeta, SEARCH_APP_ID, CURRENT_IMAGE_SEARCH_OFFER_METHODS,
    resolveImageSearchUploadInput: async candidate => {
      assert.equal(candidate, page);
      calls.inputResolutions += 1;
      if (inputResolutionError) throw inputResolutionError;
      if (inputResolutionBarrier) await inputResolutionBarrier;
      // Input selection is tested in the resolver's own suite. This fixture
      // controls its result to prove that readiness delegates that decision.
      const resolved = state.resolvedInput ?? (state.inputs ?? [{}]).some(input => !input.disabled);
      return resolved ? { fixtureUploadLocator: true } : null;
    },
    getComputedStyle: element => ({
      display: element.visible === false ? 'none' : 'block',
      visibility: element.visible === false ? 'hidden' : 'visible',
      pointerEvents: 'auto',
    }),
    process: {
      env: { BB1688_LOGIN_ATTEMPT: 'fixture-attempt', BB1688_LOGIN_TOKEN: 'fixture-token' },
      stderr: { write: value => {
        const match = /^\[image-search-verification\] ([a-z_]+)\n$/.exec(value);
        assert.ok(match && verificationStages.has(match[1]), `Unexpected stage log: ${value}`);
        calls.stageLogs.push(value);
        calls.stageEvents.push({ stage: match[1], events: [...events] });
      } },
    },
    isJson: () => true,
    defaultProfileName: value => value ?? 'default',
    requireBrokerLoginControl: () => ({}),
    readBrokerManagedImageSearchUpload: async () => managed ? upload : null,
    throwIfBrokerLoginCanceled: async () => {},
    writeBrokerEdgeReadySignal: async () => { events.push('ready'); },
    runWithBrokerLoginCancellation: async (_control, operation) => operation(),
    withNativeVisibleEdge: async (options, visible, closed) => {
      calls.native += 1;
      calls.launchUrls.push(options.launchUrl);
      let verified;
      try {
        verified = await visible(context);
        events.push('native-visible-verified');
      } finally {
        contextClosed = true;
        events.push('context-closed');
      }
      return closed(verified);
    },
    captureFailureArtifact: async (candidate, metadata, error) => {
      assert.equal(candidate, context);
      calls.artifacts.push({ metadata, error, message: error.message, pageClosed: page.isClosed() });
      events.push('artifact-capture-started');
      notifyArtifactStarted();
      if (artifactBarrier) await artifactBarrier;
      if (artifactError) throw artifactError;
      events.push('artifact-capture-completed');
      return artifactResult;
    },
    withManualVisibleEdge: async (_options, visible, closed) => {
      calls.manual += 1;
      await visible({ waitForClose: async () => { events.push('manual-close'); } });
      return closed();
    },
    requireBoundPersistentIdentity: async () => identity,
    verifyPersistedProfileIdentityWhileLocked: async () => identity,
    verifyPersistedProfileWhileLocked: async (_profile, verified) => {
      assert.equal(verified, identity);
      events.push('persistent-verified');
      return identity;
    },
    withSession: async () => { throw new Error('Managed image verification must use the native visible branch.'); },
    parseIdentity: () => identity,
    requireOnlineIdentity: async () => { events.push('online-verified'); },
    persistOfficialSessionCookies: async () => { events.push('cookies-persisted'); return identity; },
    assertSameIdentity: (a, b) => assert.equal(a.memberId, b.memberId),
    nowIso: () => '2026-01-01T00:00:00.000Z',
    writeState: async value => { calls.finalStates.push(value); },
    emit: value => { calls.emitted.push(value.data); },
    info() {}, printInteractive() {},
    sleep: advance, delay: advance,
    detectPageState: async () => ({ ...state }),
    detectImageSearchRiskControl: async () => ({ blocked: state.kind === 'risk_challenge' }),
    setVerifiedImageUpload: async (candidate, supplied) => {
      assert.equal(candidate, page);
      assert.equal(supplied, upload, 'The broker-validated image must be submitted unchanged.');
      calls.uploads += 1;
      events.push('upload');
      if (uploadError) throw uploadError;
      const data = JSON.stringify({ appId: SEARCH_APP_ID, params: { method: 'imageOfferSearchService', imageId: '123456' } });
      page.emit('request', {
        resourceType: () => 'xhr', method: () => 'POST',
        url: () => `https://h5api.m.1688.com/h5/${SEARCH_MTOP_API}/1.0/?data=${encodeURIComponent(data)}`,
        postData: () => null,
      });
    },
    clickImageSearchButton: async () => { throw new Error('A started upload must never receive a second submit click.'); },
  });
  const run = vm.runInContext(`${source}\nrun`, mock);
  return { run: () => run({ purpose: 'image_search', timeout }), calls, events, page, artifactStarted, elapsed: () => time,
    inspectUpload: () => vm.runInContext('inspectImageSearchUploadPage', mock)(page),
    samples: () => ({ before: beforeSamples, after: afterSamples }) };
}

test('an unresponsive DOM probe cannot bypass the upload-readiness deadline', { timeout: 4000 }, async () => {
  const mock = harness();
  mock.page.evaluate = () => new Promise(() => {});
  const inspection = await mock.inspectUpload();
  assert.equal(inspection.recognized, true);
  assert.equal(inspection.ready, false);
  assert.equal(mock.calls.inputResolutions, 0);
  assert.equal(mock.calls.uploads, 0);
});

test('an unresponsive shared input resolver cannot bypass the upload-readiness deadline', { timeout: 4000 }, async () => {
  const mock = harness({ inputResolutionBarrier: new Promise(() => {}) });
  const inspection = await mock.inspectUpload();
  assert.equal(inspection.recognized, true);
  assert.equal(inspection.ready, false);
  assert.equal(mock.calls.inputResolutions, 1);
  assert.equal(mock.calls.uploads, 0);
});

test('a page outside the trusted business hosts never probes DOM or resolves an upload input', async () => {
  const mock = harness({ before: [{ ...normal('https://example.test/image-search'), marker: true, resolvedInput: true }] });
  const inspection = await mock.inspectUpload();
  assert.equal(inspection.recognized, false);
  assert.equal(inspection.ready, false);
  assert.equal(mock.calls.pageProbes, 0);
  assert.equal(mock.calls.inputResolutions, 0);
  assert.equal(mock.calls.uploads, 0);
});

function assertUnverified(mock) {
  assert.deepEqual(mock.calls.finalStates, []);
  assert.deepEqual(mock.calls.emitted, []);
  assert.equal(mock.calls.manual, 0);
  assert.ok(!mock.events.includes('online-verified'));
  assert.ok(!mock.events.includes('cookies-persisted'));
  assert.equal(mock.page.listenerCount('request'), 0);
}

function assertStageLogs(mock, stages) {
  assert.deepEqual(mock.calls.stageLogs, stages.map(stage => `[image-search-verification] ${stage}\n`));
  assert.doesNotMatch(mock.calls.stageLogs.join(''), /https?:|secret|fixture-member|fixture-account|fixture-token|fixture-attempt|same-task-image|synthetic-verified-image|private-fragment/);
}

test('broker image verification reuses native image search and publishes success only after six normal new-result samples', async () => {
  const mock = harness();
  await mock.run();
  assert.equal(mock.calls.native, 1);
  assert.equal(mock.calls.manual, 0);
  assert.deepEqual(mock.calls.launchUrls, [uploadUrl]);
  assert.deepEqual(mock.calls.navigation, []);
  assert.equal(mock.calls.uploads, 1);
  assert.equal(mock.samples().after, 6);
  assert.equal(mock.calls.finalStates.length, 1);
  assert.equal(mock.calls.emitted[0].ok, true);
  assert.deepEqual(mock.events, ['ready', 'front', 'upload', 'online-verified', 'cookies-persisted', 'native-visible-verified', 'context-closed', 'persistent-verified']);
  assert.deepEqual(mock.calls.artifacts, []);
  assertStageLogs(mock, ['waiting_upload_page', 'upload_control_ready', 'image_selected_waiting_result', 'verified_result']);
  const verifiedStage = mock.calls.stageEvents.find(entry => entry.stage === 'verified_result');
  assert.ok(verifiedStage.events.includes('online-verified'), 'The account identity must be verified before announcing a verified result.');
});

test('successful verification emits only four fixed stage logs without the page URL or private fields', async () => {
  const mock = harness({ before: [normal(`${legacyUploadUrl}?secret=fixture-token#private-fragment`)] });
  await mock.run();
  assert.equal(mock.calls.uploads, 1);
  assertStageLogs(mock, ['waiting_upload_page', 'upload_control_ready', 'image_selected_waiting_result', 'verified_result']);
});

test('result timeout awaits one failure artifact before closing the context and merges only artifactDir', { timeout: 4000 }, async () => {
  let releaseArtifact;
  const artifactBarrier = new Promise(resolve => { releaseArtifact = resolve; });
  const artifactDir = 'D:/synthetic-fixture-artifact-dir';
  const mock = harness({
    after: [normal(`${legacyUploadUrl}?secret=fixture-token#private-fragment`)],
    artifactBarrier,
    artifactResult: {
      artifactDir,
      currentUrl: `${legacyUploadUrl}?secret=fixture-token#private-fragment`,
      memberId: 'fixture-member', token: 'fixture-token',
    },
  });
  let failure;
  const rejected = assert.rejects(mock.run(), error => {
    failure = error;
    assert.equal(error.code, 'IMAGE_SEARCH_RESULT_TIMEOUT');
    assert.deepEqual({ ...error.details }, {
      currentUrl: legacyUploadUrl, hasImageId: false, hasNewImageId: false, artifactDir,
    });
    assert.doesNotMatch(error.message, /synthetic-fixture-artifact-dir|secret|fixture-token|private-fragment/);
    return true;
  });
  await mock.artifactStarted;
  assert.equal(mock.calls.artifacts.length, 1);
  assert.equal(mock.calls.artifacts[0].pageClosed, false);
  assert.equal(mock.page.isClosed(), false);
  assert.ok(!mock.events.includes('context-closed'));
  assert.deepEqual(JSON.parse(JSON.stringify(mock.calls.artifacts[0].metadata)), {
    cmd: 'image-search-verification', args: {},
  });
  assert.doesNotMatch(JSON.stringify(mock.calls.artifacts[0].metadata), /buffer|member|token|fixture|secret/);
  releaseArtifact();
  await rejected;
  assert.equal(mock.calls.artifacts[0].error, failure, 'The original CliError object must survive artifact capture.');
  assert.equal(mock.calls.artifacts[0].message, failure.message);
  assert.ok(mock.events.indexOf('artifact-capture-completed') < mock.events.indexOf('context-closed'));
  assert.equal(mock.calls.uploads, 1);
  assertUnverified(mock);
});

test('failure-artifact errors do not replace the original CliError or cause another upload', async () => {
  const original = new CliError(14, 'FIXTURE_UPLOAD_FAILURE', 'Synthetic upload failure.', { preserved: true });
  const mock = harness({ uploadError: original, artifactError: new Error('Synthetic artifact storage failure.') });
  await assert.rejects(mock.run(), error => {
    assert.equal(error, original);
    assert.equal(error.code, 'FIXTURE_UPLOAD_FAILURE');
    assert.equal(error.message, 'Synthetic upload failure.');
    assert.deepEqual(error.details, { preserved: true });
    return true;
  });
  assert.equal(mock.calls.artifacts.length, 1);
  assert.equal(mock.calls.artifacts[0].error, original);
  assert.equal(mock.calls.artifacts[0].pageClosed, false);
  assert.ok(mock.events.indexOf('artifact-capture-started') < mock.events.indexOf('context-closed'));
  assert.equal(mock.calls.uploads, 1);
  assertUnverified(mock);
});

test('a plain managed-verification error preserves its message while becoming INTERNAL with its artifact directory', async () => {
  const original = new Error('Synthetic plain upload failure.');
  const artifactDir = 'D:/synthetic-fixture-artifact-dir';
  const mock = harness({ uploadError: original, artifactResult: { artifactDir } });
  await assert.rejects(mock.run(), error => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.message, original.message);
    assert.deepEqual({ ...error.details }, { artifactDir });
    return true;
  });
  assert.equal(mock.calls.artifacts.length, 1);
  assert.equal(mock.calls.artifacts[0].message, original.message);
  assert.equal(mock.calls.artifacts[0].pageClosed, false);
  assert.equal(mock.calls.uploads, 1);
  assertUnverified(mock);
});

test('an unsupported page reports sanitized diagnostic details and only the waiting stage', async () => {
  const currentUrl = 'https://s.1688.com/unknown-page';
  const mock = harness({ before: [normal(`${currentUrl}?secret=fixture-token#private-fragment`)], timeout: '900' });
  await assert.rejects(mock.run(), error => {
    assert.equal(error.code, 'IMAGE_SEARCH_UPLOAD_PAGE_UNSUPPORTED');
    assert.deepEqual({ ...error.details }, { currentUrl, recognized: false, hasUploadControl: true });
    assert.doesNotMatch(JSON.stringify(error.details), /[?#]|secret|fixture-token|private-fragment/);
    return true;
  });
  assert.equal(mock.calls.uploads, 0);
  assertStageLogs(mock, ['waiting_upload_page']);
  assertUnverified(mock);
});

test('a recognized page without controls reports sanitized diagnostic details and only the waiting stage', async () => {
  const mock = harness({ before: [{ ...normal(`${legacyUploadUrl}?secret=fixture-token#private-fragment`), inputs: [] }], timeout: '900' });
  await assert.rejects(mock.run(), error => {
    assert.equal(error.code, 'IMAGE_SEARCH_UPLOAD_CONTROL_MISSING');
    assert.deepEqual({ ...error.details }, { currentUrl: legacyUploadUrl, recognized: true, hasUploadControl: false });
    assert.doesNotMatch(JSON.stringify(error.details), /[?#]|secret|fixture-token|private-fragment/);
    return true;
  });
  assert.equal(mock.calls.uploads, 0);
  assertStageLogs(mock, ['waiting_upload_page']);
  assertUnverified(mock);
});

test('a legacy image-search page with an enabled image input submits the broker image once', async () => {
  const mock = harness({ before: [normal(legacyUploadUrl)] });
  await mock.run();
  assert.equal(mock.calls.uploads, 1);
  assert.ok(mock.calls.pageProbes > 0);
  assert.deepEqual(mock.calls.navigation, []);
  assert.equal(mock.calls.emitted[0].ok, true);
});

test('readiness accepts the shared resolver selection of a hidden extension-accepting input', async () => {
  const mock = harness({ before: [{
    ...normal(legacyUploadUrl),
    inputs: [{ disabled: true, accept: 'image/*' }, { accept: '.jpg,.png,.webp', hidden: true }],
    resolvedInput: true,
  }] });
  await mock.run();
  assert.equal(mock.calls.inputResolutions, 1);
  assert.equal(mock.calls.uploads, 1);
  assert.equal(mock.calls.emitted[0].ok, true);
});

test('DOM file inputs cannot bypass a null result from the shared input resolver', async () => {
  const mock = harness({ before: [{ ...normal(legacyUploadUrl), inputs: [{}], resolvedInput: false }], timeout: '900' });
  await assert.rejects(mock.run(), { code: 'IMAGE_SEARCH_UPLOAD_CONTROL_MISSING' });
  assert.ok(mock.calls.inputResolutions > 0);
  assert.equal(mock.calls.uploads, 0);
  assertStageLogs(mock, ['waiting_upload_page']);
  assertUnverified(mock);
});

test('an ambiguous shared input selection fails immediately without swallowing the error or uploading', async () => {
  const original = new CliError(14, 'IMAGE_UPLOAD_CONTROL_AMBIGUOUS', 'Synthetic multiple upload controls.', { candidates: 2 });
  const mock = harness({
    before: [{ ...normal(legacyUploadUrl), inputs: [{}, {}], buttons: [{ innerText: '上传图片' }] }],
    inputResolutionError: original,
  });
  await assert.rejects(mock.run(), error => {
    assert.equal(error, original);
    assert.deepEqual(error.details, { candidates: 2 });
    return true;
  });
  assert.equal(mock.calls.inputResolutions, 1);
  assert.ok(mock.elapsed() < 15_000);
  assert.equal(mock.calls.uploads, 0);
  assert.equal(mock.calls.artifacts.length, 1);
  assert.equal(mock.calls.artifacts[0].error, original);
  assert.equal(mock.calls.artifacts[0].pageClosed, false);
  assertStageLogs(mock, ['waiting_upload_page']);
  assertUnverified(mock);
});

test('a legacy image-search page with a visible upload button can submit without a preexisting file input', async () => {
  const mock = harness({ before: [{ ...normal(legacyUploadUrl), inputs: [], buttons: [{ textContent: '上传图片', innerText: '上传图片' }] }] });
  await mock.run();
  assert.equal(mock.calls.inputResolutions, 1);
  assert.equal(mock.calls.uploads, 1);
  assert.deepEqual(mock.calls.navigation, []);
});

for (const [name, controls] of [
  ['no upload controls', { inputs: [] }],
  ['only a disabled input', { inputs: [{ disabled: true }] }],
  ['only an invisible upload button', { inputs: [], buttons: [{ textContent: '上传图片', innerText: '上传图片', visible: false }] }],
]) {
  test(`a legacy image-search page with ${name} fails specifically within the upload-readiness deadline`, async () => {
    const mock = harness({ before: [{ ...normal(legacyUploadUrl), ...controls }], timeout: '900' });
    await assert.rejects(mock.run(), { code: 'IMAGE_SEARCH_UPLOAD_CONTROL_MISSING' });
    assert.ok(mock.elapsed() >= 15_000 && mock.elapsed() <= 15_500, `Readiness took ${mock.elapsed()} ms.`);
    assert.equal(mock.calls.uploads, 0);
    assert.deepEqual(mock.calls.navigation, []);
    assertUnverified(mock);
  });
}

for (const hostname of ['s.1688.com', 'air.1688.com', 'www.1688.com']) {
  test(`the image-search application marker and an upload input recognize a new path on ${hostname}`, async () => {
    const mock = harness({ before: [{ ...normal(`https://${hostname}/new-image-search-entry`), marker: true }] });
    await mock.run();
    assert.equal(mock.calls.uploads, 1);
    assert.deepEqual(mock.calls.navigation, []);
    assert.equal(mock.calls.emitted[0].ok, true);
  });
}

test('an unknown 1688 page with a file input but no application marker fails within 15 seconds', async () => {
  const mock = harness({ before: [normal('https://s.1688.com/unrelated-page')], timeout: '900' });
  await assert.rejects(mock.run(), { code: 'IMAGE_SEARCH_UPLOAD_PAGE_UNSUPPORTED' });
  assert.ok(mock.elapsed() >= 15_000 && mock.elapsed() <= 15_500, `Readiness took ${mock.elapsed()} ms.`);
  assert.equal(mock.calls.uploads, 0);
  assert.ok(mock.calls.inputResolutions > 0);
  assert.deepEqual(mock.calls.navigation, []);
  assertUnverified(mock);
});

test('a new image-search path with the application marker still requires an upload control', async () => {
  const mock = harness({ before: [{ ...normal('https://air.1688.com/new-image-search-entry'), marker: true, inputs: [] }], timeout: '900' });
  await assert.rejects(mock.run(), { code: 'IMAGE_SEARCH_UPLOAD_CONTROL_MISSING' });
  assert.ok(mock.elapsed() >= 15_000 && mock.elapsed() <= 15_500, `Readiness took ${mock.elapsed()} ms.`);
  assert.equal(mock.calls.uploads, 0);
  assertUnverified(mock);
});

for (const challenge of [
  { ...risk, marker: true },
  { ...normal(`${legacyUploadUrl}?captcha=synthetic`), marker: true },
]) {
  test(`an initial challenge takes priority over upload readiness (${challenge.kind})`, async () => {
    const mock = harness({ before: [challenge] });
    await assert.rejects(mock.run(), { code: 'RISK_CONTROL' });
    assert.equal(mock.elapsed(), 30_000);
    assert.equal(mock.calls.uploads, 0);
    assert.equal(mock.calls.pageProbes, 0);
    assert.equal(mock.calls.inputResolutions, 0);
    assert.deepEqual(mock.calls.navigation, []);
    assertStageLogs(mock, ['waiting_upload_page', 'waiting_manual_verification']);
    assertUnverified(mock);
  });
}

test('a manual challenge lasting longer than the readiness deadline may clear before one upload', async () => {
  const mock = harness({ before: [...repeat(risk, 40), normal(legacyUploadUrl)] });
  await mock.run();
  assert.equal(mock.samples().before, 41);
  assert.equal(mock.calls.uploads, 1);
  assert.deepEqual(mock.calls.navigation, []);
});

test('an already logged-in account remaining on the upload page cannot complete image verification', async () => {
  const mock = harness({ after: [normal(uploadUrl)] });
  await assert.rejects(mock.run(), { code: 'IMAGE_SEARCH_RESULT_TIMEOUT' });
  assert.equal(mock.calls.uploads, 1);
  assertUnverified(mock);
});

for (const [name, before, after, details] of [
  ['no result image ID', [normal(uploadUrl)], [normal(`${legacyUploadUrl}?secret=fixture-token#private-fragment`)], {
    currentUrl: legacyUploadUrl, hasImageId: false, hasNewImageId: false,
  }],
  ['only the previous image ID', [normal(resultUrl('999999'))], [normal(`${resultUrl('999999')}&secret=fixture-token#private-fragment`)], {
    currentUrl: 'https://air.1688.com/kapp/1688-search/pc-image-search', hasImageId: true, hasNewImageId: false,
  }],
]) {
  test(`normal result waiting with ${name} times out after 60 seconds with sanitized details and one upload`, async () => {
    const mock = harness({ before, after, timeout: '900' });
    await assert.rejects(mock.run(), error => {
      assert.equal(error.code, 'IMAGE_SEARCH_RESULT_TIMEOUT');
      assert.deepEqual({ ...error.details }, details);
      assert.doesNotMatch(JSON.stringify(error.details), /[?#]|secret|fixture-token|private-fragment|999999/);
      return true;
    });
    assert.ok(mock.elapsed() >= 60_000 && mock.elapsed() <= 61_500, `Result waiting took ${mock.elapsed()} ms.`);
    assert.equal(mock.calls.uploads, 1);
    assert.deepEqual(mock.calls.navigation, []);
    assertStageLogs(mock, ['waiting_upload_page', 'upload_control_ready', 'image_selected_waiting_result']);
    assertUnverified(mock);
  });
}

test('changing result IDs without six stable samples still reaches the normal result timeout', async () => {
  const after = Array.from({ length: 125 }, (_, index) => normal(`${resultUrl(index % 2 ? '123456' : '654321')}&secret=fixture-token#private-fragment`));
  const mock = harness({ after, timeout: '900' });
  await assert.rejects(mock.run(), error => {
    assert.equal(error.code, 'IMAGE_SEARCH_RESULT_TIMEOUT');
    assert.deepEqual({ ...error.details }, {
      currentUrl: 'https://air.1688.com/kapp/1688-search/pc-image-search', hasImageId: true, hasNewImageId: true,
    });
    return true;
  });
  assert.ok(mock.elapsed() >= 60_000 && mock.elapsed() <= 61_500, `Result waiting took ${mock.elapsed()} ms.`);
  assert.equal(mock.calls.uploads, 1);
  assertUnverified(mock);
});

test('a persistent result challenge retains the full manual budget and logs manual waiting only once', async () => {
  const mock = harness({ after: [risk], timeout: '900' });
  await assert.rejects(mock.run(), { code: 'RISK_CONTROL' });
  assert.equal(mock.elapsed(), 900_000);
  assert.equal(mock.calls.uploads, 1);
  assert.deepEqual(mock.calls.navigation, []);
  assertStageLogs(mock, ['waiting_upload_page', 'upload_control_ready', 'image_selected_waiting_result', 'waiting_manual_verification']);
  assertUnverified(mock);
});

test('a challenge exceeding 60 seconds clears the normal timer and restores result waiting without another upload', async () => {
  const mock = harness({
    after: [...repeat(normal(uploadUrl), 100), ...repeat(risk, 140), ...repeat(normal(uploadUrl), 100), ...repeat(result, 6)],
    timeout: '900',
  });
  await mock.run();
  assert.equal(mock.samples().after, 346);
  assert.ok(mock.elapsed() > 170_000);
  assert.equal(mock.calls.uploads, 1);
  assert.deepEqual(mock.calls.navigation, []);
  assertStageLogs(mock, [
    'waiting_upload_page', 'upload_control_ready', 'image_selected_waiting_result',
    'waiting_manual_verification', 'image_selected_waiting_result', 'verified_result',
  ]);
});

test('closing the dedicated window before a verified image result is cancellation, even with valid account cookies', async () => {
  const mock = harness({ after: [{ ...risk, closed: true }] });
  await assert.rejects(mock.run(), { code: 'CANCELED' });
  assert.equal(mock.calls.uploads, 1);
  assertUnverified(mock);
});

test('a previous image result cannot be reused as proof for the current broker image', async () => {
  const stale = normal(resultUrl('999999'));
  const mock = harness({ before: [stale], after: [normal(`${stale.url}&page=1`)] });
  await assert.rejects(mock.run(), { code: 'IMAGE_SEARCH_RESULT_TIMEOUT' });
  assert.equal(mock.calls.uploads, 1);
  assertUnverified(mock);
});

test('manual challenges reset the consecutive sample count without another upload or navigation', async () => {
  const mock = harness({ after: [...repeat(result, 5), risk, ...repeat(result, 6)] });
  await mock.run();
  assert.equal(mock.samples().after, 12);
  assert.equal(mock.calls.uploads, 1);
  assert.deepEqual(mock.calls.navigation, []);
  assertStageLogs(mock, [
    'waiting_upload_page', 'upload_control_ready', 'image_selected_waiting_result',
    'waiting_manual_verification', 'image_selected_waiting_result', 'verified_result',
  ]);
});

test('a challenge URL carrying an image ID is not a verified result even if the page classifier reports normal', async () => {
  const mock = harness({ after: [normal(`${result.url}&x5secdata=synthetic`)] });
  await assert.rejects(mock.run(), { code: 'RISK_CONTROL' });
  assertUnverified(mock);
});

test('the initial manual challenge is preserved until the user returns to the upload page', async () => {
  const mock = harness({ before: [risk, risk, normal(uploadUrl)] });
  await mock.run();
  assert.deepEqual(mock.calls.navigation, []);
  assert.equal(mock.samples().before, 3);
  assert.equal(mock.calls.uploads, 1);
  assertStageLogs(mock, [
    'waiting_upload_page', 'waiting_manual_verification', 'waiting_upload_page',
    'upload_control_ready', 'image_selected_waiting_result', 'verified_result',
  ]);
});

test('a slow result waits on the first upload without performing a timed second submission', async () => {
  const mock = harness({ after: [...repeat(normal(uploadUrl), 20), ...repeat(result, 6)] });
  await mock.run();
  assert.equal(mock.samples().after, 26);
  assert.equal(mock.calls.uploads, 1);
  assert.deepEqual(mock.calls.navigation, []);
});

test('changing image IDs restarts the stability check', async () => {
  const mock = harness({ after: [...repeat(result, 5), ...repeat(normal(resultUrl('654321')), 6)] });
  await mock.run();
  assert.equal(mock.samples().after, 11);
  assert.equal(mock.calls.uploads, 1);
});

for (const [kind, code] of [['not_logged_in', 'NOT_LOGGED_IN'], ['rate_limited', 'RATE_LIMITED']]) {
  test(`${kind} cannot publish image verification success`, async () => {
    const mock = harness({ after: [{ kind, url: uploadUrl }] });
    await assert.rejects(mock.run(), { code });
    assertUnverified(mock);
  });
}

test('independent verification without a broker image retains the manual-only window branch', async () => {
  const mock = harness({ managed: false });
  await mock.run();
  assert.equal(mock.calls.native, 0);
  assert.equal(mock.calls.manual, 1);
  assert.equal(mock.calls.uploads, 0);
  assert.ok(mock.events.includes('manual-close'));
});
