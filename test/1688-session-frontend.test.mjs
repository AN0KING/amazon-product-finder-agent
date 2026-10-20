import * as listingDate from "../lib/amazon-listing-date.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as priceState from "../lib/amazon-price-state.mjs";
import * as profitModel from "../lib/profit-model.mjs";
import * as pieceCount from "../lib/title-piece-count.mjs";
import * as handoff from "../lib/analysis-handoff.mjs";
import * as coverage from "../lib/analysis-coverage.mjs";
import * as detailRetry from "../lib/amazon-detail-retry.mjs";
import * as salesPolicy from "../lib/monthly-sales-policy.mjs";

const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
const taskId = "task_synthetic_image_search";
const ratePolicy = (overrides = {}) => ({ minGapMs: 30_000, maxConcurrent: 1, cooldownEvery: 5, cooldownMs: 30_000,
  nextAllowedAt: null, pausedReason: null, manualVerificationCompletedAt: null, ...overrides });
const runtime = ({ auth = { ready: true, checking: false, reason: "ready" }, queue = {}, imageSearchRecovery = null } = {}) => ({
  auth, queue: { queued: 0, running: 0, riskBlocked: 0, activeTasks: [], ratePolicy: ratePolicy(), ...queue }, imageSearchRecovery,
});

function harness() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, textContent: "", value: "", checked: false, dataset: {}, title: "",
      classList: { add() {}, remove() {}, toggle() {} }, setAttribute(name, value) { this[name] = value; }, addEventListener() {}, querySelector() { return null; } });
    return elements.get(id);
  };
  const calls = [], toasts = [], intervals = [], timeouts = [];
  let resumeCount = 0;
  let respond = async (path) => { throw new Error(`Unexpected request ${path}`); };
  const context = vm.createContext({
    ...priceState, ...listingDate, ...profitModel, ...pieceCount, ...handoff, ...coverage, ...detailRetry, ...salesPolicy, structuredClone, AbortController, DOMException, URL,
    document: { addEventListener() {}, getElementById: element, querySelector() { return null; }, querySelectorAll() { return []; } },
    window: { setInterval(callback, ms) { intervals.push({ callback, ms }); return intervals.length; }, clearInterval() {},
      setTimeout(callback, ms) { timeouts.push({ callback, ms, canceled: false }); return timeouts.length; },
      clearTimeout(id) { if (timeouts[id - 1]) timeouts[id - 1].canceled = true; } },
    setTimeout() { return 1; }, clearTimeout() {},
    async fixtureApi(path, options = {}) {
      calls.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
      return respond(path, options);
    },
    fixtureToast: (...args) => toasts.push(args),
    fixtureResume: async () => { resumeCount += 1; return true; },
  });
  const source = appSource.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/\}\)\(\);\s*$/, `
    // Keep updateStartAvailability real so pending actions must release button locks.
    initIcons = renderResults = renderSupplier1688Stage = syncManualCostReadOnlyState = syncStoreManagerControls = () => {};
    ensure1688ServiceAvailable = async () => ({ ready: true });
    resumePending1688Candidates = fixtureResume;
    apiRequest = fixtureApi;
    showToast = fixtureToast;
    runState = { ...createIdleRunState(), id: 'synthetic-session-run', mode: 'live', marketplace: 'AU',
      supplier1688Pipeline: { status: 'paused', productIds: ['AU:B000000001'] } };
    products = [{ id: 'AU:B000000001', asin: 'B000000001', sourceAsin: 'B000000001', marketplace: 'AU',
      sales30: 50, sales30Evidence: { source: 'amazon_product_page', period: 'past_month', kind: 'lower_bound',
        value: 50, rawText: '50+ bought in past month', asin: 'B000000001' },
      imageUrl: 'https://m.media-amazon.com/images/I/fixture.jpg', supplierSearchStatus: 'queue_waiting',
      supplierProcurementTaskId: '${taskId}', manualPurchaseCost: false, reviewStatus: 'pending' }];
    globalThis.scout = {
      start: start1688Session, load: load1688SessionStatus, poll: poll1688Status,
      apply: (value) => apply1688SessionStatus(value.auth, value.queue, value.imageSearchRecovery),
      renderMessage: render1688SessionStatusMessage, schedule: schedule1688StatusPolling,
      resumeAfterVerification: (...args) => resume1688AfterVerification(...args),
      state: () => ({ loggedIn: supplier1688LoggedIn, status: supplier1688Status, auth: supplier1688Auth,
        riskTask: supplier1688RiskTask, riskScope: supplier1688RiskTaskScope, queue: supplier1688Queue }),
    };
  })();`);
  vm.runInContext(source, context, { filename: "app.js" });
  return { app: context.scout, calls, toasts, element, intervals, timeouts, resumes: () => resumeCount, respond(fn) { respond = fn; } };
}

for (const systemRisk of [false, true]) {
  test(`cached logged-out state still opens ${systemRisk ? "system" : "current"} image verification without restarting login`, async () => {
    const fixture = harness();
    const blockedTaskId = systemRisk ? "task_system_image_risk" : taskId;
    const blocked = runtime({ auth: { ready: false, checking: false, reason: "risk_control" }, queue: {
      riskBlocked: 1, activeTasks: [{ id: blockedTaskId, status: "risk_blocked" }], ratePolicy: ratePolicy({ pausedReason: "risk_control" }),
    } });
    fixture.app.apply(blocked);
    assert.equal(fixture.app.state().loggedIn, false);
    fixture.respond(async (path) => {
      if (path === "/api/v1/runtime") return blocked;
      if (path === "/api/v1/auth/open-login") return { edgeReady: true, alreadyRunning: true };
      throw new Error(`Unexpected request ${path}`);
    });
    await fixture.app.start();
    await fixture.app.start();
    const opens = fixture.calls.filter((call) => call.path === "/api/v1/auth/open-login");
    assert.equal(opens.length, 2);
    opens.forEach((call) => assert.deepEqual(call.body, { purpose: "image_search", restart: false, taskId: blockedTaskId }));
    assert.ok(fixture.calls.filter((call) => call.path === "/api/v1/runtime").length >= 2);
    assert.equal(fixture.calls.some((call) => call.path.includes("verify=")), false);
  });
}

for (const imageSearch of [false, true]) {
  test(`explicit restart forwards restart:true for ${imageSearch ? "image verification" : "ordinary login"}`, async () => {
    const fixture = harness();
    const current = runtime({ auth: { ready: true, reason: "ready", windowOpen: true }, queue: imageSearch ? {
      riskBlocked: 1, activeTasks: [{ id: taskId, status: "risk_blocked" }],
      ratePolicy: ratePolicy({ pausedReason: "RISK_VERIFICATION_REQUIRED" }),
    } : {} });
    fixture.app.apply(current);
    fixture.respond(async (path) => {
      if (path === "/api/v1/runtime") return current;
      if (path === "/api/v1/auth/open-login") return { edgeReady: true };
      throw new Error(`Unexpected request ${path}`);
    });
    await fixture.app.start({ restart: true });
    const opens = fixture.calls.filter(call => call.path === "/api/v1/auth/open-login");
    assert.equal(opens.length, 1);
    assert.deepEqual(opens[0].body, { purpose: imageSearch ? "image_search" : "login", restart: true,
      ...(imageSearch ? { taskId } : {}) });
  });
}

test("ordinary login defaults to reusing its window without restart", async () => {
  const fixture = harness();
  fixture.respond(async (path) => {
    if (path === "/api/v1/runtime") return runtime();
    if (path === "/api/v1/auth/open-login") return { edgeReady: true };
    throw new Error(`Unexpected request ${path}`);
  });
  await fixture.app.start();
  const opens = fixture.calls.filter(call => call.path === "/api/v1/auth/open-login");
  assert.equal(opens.length, 1);
  assert.deepEqual(opens[0].body, { purpose: "login", restart: false });
});

for (const source of ["auth.windowOpen", "queue.waitingLogin"]) {
  test(`${source} reveals the restart button even when the cached account is ready`, () => {
    const fixture = harness();
    fixture.app.apply(runtime());
    assert.equal(fixture.element("restart1688Button").hidden, true);
    fixture.app.apply(runtime(source === "auth.windowOpen"
      ? { auth: { ready: true, reason: "ready", windowOpen: true } }
      : { queue: { waitingLogin: true } }));
    assert.equal(fixture.element("restart1688Button").hidden, false);
    assert.equal(fixture.element("restart1688Button").disabled, false);
    fixture.app.apply(runtime());
    assert.equal(fixture.element("restart1688Button").hidden, true);
  });
}

function verifiedWithWindow() {
  return runtime({ auth: { ready: true, reason: "ready", windowOpen: true }, queue: {
    riskBlocked: 1, activeTasks: [{ id: taskId, status: "risk_blocked" }],
    ratePolicy: ratePolicy({ pausedReason: "RISK_VERIFICATION_REQUIRED", manualVerificationCompletedAt: new Date().toISOString() }),
  } });
}

test("a completed async runtime load enables visible resume and restart controls", async () => {
  const fixture = harness();
  let complete;
  fixture.respond(() => new Promise(resolve => { complete = resolve; }));
  const loading = fixture.app.load();
  complete(verifiedWithWindow());
  assert.equal(await loading, true);
  for (const id of ["resume1688Button", "restart1688Button"]) {
    assert.equal(fixture.element(id).hidden, false, id);
    assert.equal(fixture.element(id).disabled, false, id);
  }
});

for (const outcome of ["ready", "pending", "failure", "exception"]) {
  test(`session start ${outcome} releases disabled resume and restart controls after the request finishes`, async () => {
    const fixture = harness();
    const current = verifiedWithWindow();
    fixture.app.apply(current);
    let finishOpen;
    let opened;
    const requestStarted = new Promise(resolve => { opened = resolve; });
    fixture.respond(async (path) => {
      if (path === "/api/v1/runtime") return current;
      if (path === "/api/v1/auth/open-login") {
        opened();
        await new Promise(resolve => { finishOpen = resolve; });
        if (outcome === "exception") throw new Error("Synthetic window startup failure");
        return outcome === "pending" ? { pending: true, edgeReady: false } : { edgeReady: outcome === "ready" };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const starting = fixture.app.start({ restart: true });
    await requestStarted;
    for (const id of ["resume1688Button", "restart1688Button"]) assert.equal(fixture.element(id).disabled, true, id);
    finishOpen();
    await starting;
    for (const id of ["resume1688Button", "restart1688Button"]) {
      assert.equal(fixture.element(id).hidden, false, id);
      assert.equal(fixture.element(id).disabled, false, id);
    }
  });
}

test("a rejected manual resume refreshes status and leaves visible controls available to retry", async () => {
  const fixture = harness();
  const current = verifiedWithWindow();
  fixture.app.apply(current);
  fixture.respond(async (path) => {
    if (path === "/api/v1/queue/resume") throw new Error("Verification window is still open");
    if (path === "/api/v1/runtime") return current;
    throw new Error(`Unexpected request ${path}`);
  });
  assert.equal(await fixture.app.resumeAfterVerification(), false);
  assert.deepEqual(fixture.calls.map(call => call.path), ["/api/v1/queue/resume", "/api/v1/runtime"]);
  for (const id of ["resume1688Button", "restart1688Button"]) {
    assert.equal(fixture.element(id).hidden, false, id);
    assert.equal(fixture.element(id).disabled, false, id);
  }
});

for (const throws of [false, true]) {
  test(`a window-opening ${throws ? "exception" : "failure response"} retains an existing verified identity`, async () => {
    const fixture = harness();
    const verified = runtime();
    fixture.app.apply(verified);
    fixture.respond(async (path) => {
      if (path === "/api/v1/runtime") return verified;
      if (path === "/api/v1/auth/open-login") {
        if (throws) throw Object.assign(new Error("Synthetic window could not be shown"), { code: "WINDOW_NOT_VISIBLE" });
        return { edgeReady: false };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    await fixture.app.start();
    assert.equal(fixture.app.state().loggedIn, true);
    assert.equal(fixture.app.state().auth.ready, true);
    assert.equal(fixture.app.state().status, "ready");
    assert.equal(fixture.calls.at(-1).path, "/api/v1/runtime");
    assert.equal(fixture.calls.some((call) => call.path.includes("verify=")), false);
    assert.equal(fixture.toasts.some(([message]) => /登录失败|重新登录/.test(message)), false);
  });
}

const blockedRuntimes = [
  ["blocked", runtime({ queue: { ratePolicy: ratePolicy({ pausedReason: "blocked" }) } })],
  ["verification_required", runtime({ queue: { ratePolicy: ratePolicy({ pausedReason: "verification_required" }) } })],
  ["cooldown", runtime({ queue: { ratePolicy: ratePolicy({ pausedReason: "cooldown" }) } })],
  ["future nextAllowedAt", runtime({ queue: { ratePolicy: ratePolicy({ nextAllowedAt: new Date(Date.now() + 300_000).toISOString() }) } })],
  ["risk-blocked task", runtime({ queue: { riskBlocked: 1, activeTasks: [{ id: taskId, status: "risk_blocked" }] } })],
  ["queued work", runtime({ queue: { queued: 1 } })],
  ["running work", runtime({ queue: { running: 1 } })],
  ["waiting for login", runtime({ queue: { waitingLogin: true } })],
  ["identity not ready", runtime({ auth: { ready: false, reason: "verification_required" } })],
];
for (const [reason, blocked] of blockedRuntimes) {
  test(`status polling only reads cached local status and never resumes while ${reason}`, async () => {
    const fixture = harness();
    fixture.app.apply(runtime());
    fixture.respond(async (path) => {
      assert.equal(path, "/api/v1/runtime");
      return blocked;
    });
    await fixture.app.poll();
    assert.deepEqual(fixture.calls.map(({ path, method }) => ({ path, method })), [{ path: "/api/v1/runtime", method: "GET" }]);
    assert.equal(fixture.resumes(), 0);
  });
}

test("an idle authenticated queue stays paused after a local GET until the user explicitly continues", async () => {
  const fixture = harness();
  fixture.app.apply(runtime());
  fixture.respond(async () => runtime());
  await fixture.app.poll();
  assert.deepEqual(fixture.calls.map(({ path, method }) => ({ path, method })), [{ path: "/api/v1/runtime", method: "GET" }]);
  assert.equal(fixture.resumes(), 0);
  assert.match(fixture.element("supplier1688StatusText").textContent, /请点击匹配继续/);
});

test("a failed local status read neither changes a known identity nor resumes business work", async () => {
  const fixture = harness();
  fixture.app.apply(runtime());
  fixture.respond(async () => { throw new Error("Synthetic local service timeout"); });
  await fixture.app.poll();
  assert.equal(fixture.resumes(), 0);
  assert.equal(fixture.app.state().loggedIn, true);
  assert.deepEqual(fixture.calls.map((call) => call.path), ["/api/v1/runtime"]);
});

test("runtime queue scoping retains the global rate policy and displays the configured interval", () => {
  const fixture = harness();
  const policy = ratePolicy();
  fixture.app.apply(runtime({ queue: { ratePolicy: policy } }));
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.app.state().queue.ratePolicy)), policy);
  assert.match(fixture.element("supplier1688RateText").textContent, /30\s*秒/);
  assert.match(fixture.element("supplier1688RateText").textContent, /每\s*5\s*次.*1\s*分钟/);
  const changed = ratePolicy({ minGapMs: 120_000, cooldownEvery: 7, cooldownMs: 420_000 });
  fixture.app.apply(runtime({ queue: { ratePolicy: changed } }));
  assert.match(fixture.element("supplier1688RateText").textContent, /120\s*秒|2\s*分钟/);
  assert.match(fixture.element("supplier1688RateText").textContent, /每\s*7\s*次.*7\s*分钟/);
});

test("manual-resume control is offered only after verification has completed for a paused queue", () => {
  const fixture = harness();
  fixture.app.apply(runtime({ queue: { ratePolicy: ratePolicy({ pausedReason: "risk_control" }) } }));
  assert.equal(fixture.element("resume1688Button").hidden, true);
  fixture.app.apply(runtime({ queue: { ratePolicy: ratePolicy({ pausedReason: "risk_control", manualVerificationCompletedAt: new Date().toISOString() }) } }));
  assert.equal(fixture.element("resume1688Button").hidden, false);
  fixture.app.apply(runtime({ queue: { ratePolicy: ratePolicy({ manualVerificationCompletedAt: new Date().toISOString() }) } }));
  assert.equal(fixture.element("resume1688Button").hidden, true);
  assert.equal(fixture.element("resume1688Button").disabled, false);
  assert.equal(fixture.element("restart1688Button").disabled, false);
});

test("explicit post-verification resume sends one confirmed queue action and applies the returned runtime", async () => {
  const fixture = harness();
  fixture.app.apply(runtime({ queue: { ratePolicy: ratePolicy({ pausedReason: "risk_control", manualVerificationCompletedAt: new Date().toISOString() }) } }));
  fixture.respond(async (path, options) => {
    assert.equal(path, "/api/v1/queue/resume");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { confirmed: true });
    return runtime();
  });
  await fixture.app.resumeAfterVerification();
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.app.state().queue.ratePolicy.pausedReason, null);
  assert.equal(fixture.element("resume1688Button").hidden, true);
  assert.equal(fixture.element("resume1688Button").disabled, false);
  assert.equal(fixture.element("restart1688Button").disabled, false);
});

test("a live verification window displays upload progress and refreshes only the local runtime until it closes", async () => {
  const fixture = harness();
  fixture.app.apply(runtime({ auth: { ready: true, windowOpen: true, imageSearchPhase: "image_selected_waiting_result" } }));
  assert.match(fixture.element("supplier1688StatusText").textContent, /等待搜图结果/);
  const timer = fixture.timeouts.find(item => item.ms === 3000 && !item.canceled);
  assert.ok(timer);
  fixture.respond(async path => {
    assert.equal(path, "/api/v1/runtime");
    return runtime({ auth: { ready: true, windowOpen: false, lastWindowError: {
      code: "IMAGE_SEARCH_RESULT_TIMEOUT", message: "已提交图片，但未确认本次搜图结果。",
    } } });
  });
  await timer.callback();
  assert.deepEqual(fixture.calls.map(call => [call.path, call.method]), [["/api/v1/runtime", "GET"]]);
  assert.match(fixture.element("supplier1688StatusText").textContent, /已提交图片，但未确认本次搜图结果/);
  assert.equal(fixture.element("restart1688Button").hidden, true);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.resumes(), 0);
});

test("an actual manual challenge is shown separately from a cached risk pause", () => {
  const fixture = harness();
  fixture.app.apply(runtime({ auth: { ready: true, windowOpen: true, imageSearchPhase: "waiting_manual_verification" },
    queue: { ratePolicy: ratePolicy({ pausedReason: "RISK_VERIFICATION_REQUIRED" }) } }));
  assert.match(fixture.element("supplier1688StatusText").textContent, /正在要求人工验证/);
  assert.equal(fixture.element("resume1688Button").hidden, true);
});

for (const [code, expected] of [
  ['EDGE_STARTUP_TIMEOUT', /启动连接超时/],
  ['EDGE_WINDOW_PROOF_TIMEOUT', /窗口检查超时/],
  ['EDGE_WINDOW_WRONG_DESKTOP', /当前可操作桌面/],
  ['EDGE_WINDOW_CHECK_FAILED', /窗口检查程序执行失败/],
  ['EDGE_WINDOW_NOT_VISIBLE', /未确认可操作的 Edge 窗口/],
]) {
  test(`${code} explains window closure while preserving the existing verification pause`, () => {
    const fixture = harness();
    fixture.app.apply(runtime({ auth: { ready: true, windowOpen: false, lastWindowError: {
      code, message: 'Microsoft Edge did not create a visible, usable login window.',
    } }, queue: { riskBlocked: 1, activeTasks: [{ id: taskId, status: 'risk_blocked' }],
      ratePolicy: ratePolicy({ minGapMs: 40_000, pausedReason: 'RISK_VERIFICATION_REQUIRED',
        manualResumeRequired: true, manualVerificationCompletedAt: null }) } }));
    const message = fixture.element('supplier1688StatusText').textContent;
    assert.match(message, expected);
    assert.match(message, /验证未完成/);
    assert.doesNotMatch(message, /Microsoft Edge did not create|上次窗口处理未完成/);
    assert.equal(fixture.app.state().queue.ratePolicy.minGapMs, 40_000);
    assert.equal(fixture.app.state().queue.ratePolicy.pausedReason, 'RISK_VERIFICATION_REQUIRED');
    assert.equal(fixture.element('resume1688Button').hidden, true);
    assert.equal(fixture.resumes(), 0);
    assert.equal(fixture.calls.length, 0);
  });
}

test("an online login probe failure explains the unconfirmed check without treating an opened result page as verification", async () => {
  const fixture = harness();
  fixture.app.apply(runtime({ auth: { ready: true, windowOpen: true, imageSearchPhase: "image_selected_waiting_result" } }));
  const windowPoll = fixture.timeouts.find(item => item.ms === 3000 && !item.canceled);
  assert.ok(windowPoll);
  const observedRuntime = runtime({
    auth: {
      ready: true, reason: "ready", checking: false, windowOpen: false, checkedAt: null,
      imageSearchPhase: null,
      lastWindowError: {
        code: "LOGIN_ONLINE_VERIFICATION_FAILED",
        message: "1688 did not confirm the signed-in session online.",
      },
    },
    queue: {
      riskBlocked: 1, activeTasks: [{ id: taskId, status: "risk_blocked" }],
      ratePolicy: ratePolicy({ minGapMs: 40_000, pausedReason: "RISK_VERIFICATION_REQUIRED",
        manualResumeRequired: true, manualVerificationCompletedAt: null }),
    },
  });
  fixture.respond(async path => {
    assert.equal(path, "/api/v1/runtime");
    return observedRuntime;
  });
  await windowPoll.callback();
  const message = fixture.element("supplier1688StatusText").textContent;
  assert.match(message, /在线登录校验.*未确认/);
  assert.match(message, /图片搜索队列保持暂停/);
  assert.doesNotMatch(message, /上次窗口处理未完成|did not confirm/);
  assert.match(message, /图片阻塞 1 项/);
  assert.equal(fixture.app.state().status, "image_verification_required");
  assert.equal(fixture.element("resume1688Button").hidden, true);
  assert.equal(fixture.app.state().queue.ratePolicy.minGapMs, 40_000);
  assert.equal(fixture.app.state().queue.ratePolicy.pausedReason, "RISK_VERIFICATION_REQUIRED");
  assert.equal(fixture.resumes(), 0);
  assert.deepEqual(fixture.calls.map(call => [call.path, call.method]), [["/api/v1/runtime", "GET"]]);
});

test("a confirmed image verification supersedes an earlier online probe failure without auto-resuming the queue", async () => {
  const fixture = harness();
  const oldError = {
    code: "LOGIN_ONLINE_VERIFICATION_FAILED", message: "1688 did not confirm the signed-in session online.",
  };
  const current = runtime({ auth: { ready: true, windowOpen: false, lastWindowError: oldError }, queue: {
    riskBlocked: 1, activeTasks: [{ id: taskId, status: "risk_blocked" }],
    ratePolicy: ratePolicy({ pausedReason: "RISK_VERIFICATION_REQUIRED" }),
  } });
  fixture.app.apply(current);
  fixture.respond(async path => {
    assert.equal(path, "/api/v1/runtime");
    return { ...current, queue: { ...current.queue, ratePolicy: { ...current.queue.ratePolicy,
      manualVerificationCompletedAt: "2026-10-15T01:35:00.000Z" } } };
  });
  assert.equal(await fixture.app.load(), true);
  assert.match(fixture.element("supplier1688StatusText").textContent, /图片验证已完成，等待继续搜图/);
  assert.doesNotMatch(fixture.element("supplier1688StatusText").textContent, /上次窗口处理未完成|did not confirm/);
  assert.equal(fixture.element("resume1688Button").hidden, false);
  assert.equal(fixture.app.state().queue.ratePolicy.pausedReason, "RISK_VERIFICATION_REQUIRED");
  assert.equal(fixture.resumes(), 0);
  assert.deepEqual(fixture.calls.map(call => [call.path, call.method]), [["/api/v1/runtime", "GET"]]);
});
