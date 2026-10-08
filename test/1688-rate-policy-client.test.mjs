import test from "node:test";
import assert from "node:assert/strict";
import {
  Procurement1688Client,
  PROCUREMENT_1688_ORIGIN,
  PROCUREMENT_1688_PRODUCT,
  PROCUREMENT_1688_VERSION,
  PROCUREMENT_1688_BROKER_PROTOCOL,
  PROCUREMENT_1688_INTEGRATION_PROTOCOL,
  PROCUREMENT_1688_IMAGE_CANDIDATE_LIMIT,
} from "../lib/1688-procurement-client.mjs";

const currentTaskId = "task_current_product";
const systemTaskId = "task_unrelated_system_product";
const healthPayload = () => ({
  ok: true, product: PROCUREMENT_1688_PRODUCT, version: PROCUREMENT_1688_VERSION,
  loginBrokerProtocol: PROCUREMENT_1688_BROKER_PROTOCOL, integrationProtocol: PROCUREMENT_1688_INTEGRATION_PROTOCOL,
  capabilities: { imageCandidateLimit: PROCUREMENT_1688_IMAGE_CANDIDATE_LIMIT, supplierStrengthRefresh: true,
    automaticSupplierStrength: true, imageSearchRiskRecovery: true, excelBatchImport: true, imageSearchWithoutPrice: true,
    persistentSearchRateLimit: true, manualRiskResume: true },
});
const runtimePayload = (queue = {}) => ({
  ok: true, auth: { ready: true, reason: "ready" },
  queue: { queued: 0, running: 0, riskBlocked: 0, activeTasks: [], ratePolicy: { pausedReason: null }, ...queue },
});
const searchInput = (existingTaskId = null) => ({
  imageUrl: "https://m.media-amazon.com/images/I/synthetic-product.jpg", existingTaskId,
  targetMoq: 100, targetUnit: "件", sellingPrice: null, sellingPriceCurrency: "CAD",
});

function clientHarness({ health = healthPayload(), runtime = runtimePayload(), resumeResponse = runtimePayload(),
  taskId = currentTaskId, taskResponses = null, confirmResponse = { ok: true }, candidates = [] } = {}) {
  const calls = [];
  let taskReads = 0;
  let runtimeReads = 0;
  const images = { downloaded: 0, read: 0, references: 0, candidateDownloads: 0, cleaned: 0 };
  const client = new Procurement1688Client({
    now: () => 1_000_000,
    healthProbeAttempts: 1,
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, PROCUREMENT_1688_ORIGIN, "Only the synthetic local companion is available in this test.");
      const method = options.method || "GET";
      const body = options.body === undefined ? null : JSON.parse(options.body);
      calls.push({ pathname: parsed.pathname, search: parsed.search, method, body });
      let payload;
      if (parsed.pathname === "/api/v1/health") payload = health;
      else if (parsed.pathname === "/api/v1/runtime") payload = typeof runtime === "function" ? runtime(++runtimeReads) : runtime;
      else if (parsed.pathname === "/api/v1/queue/resume") payload = resumeResponse;
      else if (parsed.pathname === "/api/v1/tasks" && method === "POST") {
        payload = { ok: true, task: { id: taskId, status: "pending_review", candidates: [] } };
      } else if (parsed.pathname === `/api/v1/tasks/${taskId}/confirm`) payload = confirmResponse;
      else if (parsed.pathname === `/api/v1/tasks/${taskId}`) {
        const task = taskResponses?.[Math.min(taskReads++, taskResponses.length - 1)]
          ?? { status: "review_candidates", candidates };
        payload = task.ok === false ? task : { ok: true, task: { id: taskId, updatedAt: "2026-09-24T00:00:00.000Z", ...task } };
      } else throw new Error(`Unexpected mocked request ${method} ${parsed.pathname}${parsed.search}`);
      return new Response(JSON.stringify(payload), { status: payload.ok === false ? 409 : 200, headers: { "Content-Type": "application/json" } });
    },
    imageDownloader: async () => {
      images.downloaded += 1;
      return { path: "synthetic-product-image", mimeType: "image/jpeg", cleanup: async () => { images.cleaned += 1; } };
    },
    readFileImpl: async () => { images.read += 1; return Buffer.from("synthetic product image"); },
    imageReferenceFactory: async () => { images.references += 1; return { compare: async () => ({ score: 0.98, method: "synthetic", version: "test-v1" }) }; },
    candidateImageDownloader: async (url) => { images.candidateDownloads += 1; return { buffer: Buffer.from("synthetic candidate image"), url }; },
    waitImpl: async () => { throw new Error("These mocked tasks complete without retry or polling delays."); },
  });
  return { client, calls, images, taskId };
}

test("image search reads cached local runtime without online verification before creating its task", async () => {
  const fixture = clientHarness();
  const result = await fixture.client.searchByImage(searchInput());
  const runtimeCalls = fixture.calls.filter((call) => call.pathname === "/api/v1/runtime");
  assert.deepEqual(runtimeCalls, Array.from({ length: 2 }, () => ({ pathname: "/api/v1/runtime", search: "", method: "GET", body: null })));
  assert.equal(fixture.calls.some((call) => call.search.includes("verify")), false);
  assert.equal(fixture.calls.filter((call) => call.pathname === "/api/v1/tasks" && call.method === "POST").length, 1);
  assert.equal(result.procurementTaskId, currentTaskId);
  assert.equal(fixture.images.downloaded, 1);
  assert.equal(fixture.images.cleaned, 1);
});

for (const [label, queue] of [
  ["persistent risk pause", { ratePolicy: { pausedReason: "risk_control" } }],
  ["manual verification pause", { ratePolicy: { pausedReason: "verification_required" } }],
  ["cooldown pause", { ratePolicy: { pausedReason: "cooldown" } }],
  ["another product's risk-blocked task", { riskBlocked: 1, activeTasks: [{ id: systemTaskId, status: "risk_blocked" }], riskBlockedTask: { id: systemTaskId, status: "risk_blocked" } }],
]) {
  for (const existingTaskId of [null, currentTaskId]) {
    test(`${label} stops ${existingTaskId ? "an existing" : "a new"} product before image download and task creation`, async () => {
      const fixture = clientHarness({ runtime: runtimePayload(queue), taskResponses: [{ status: "failed", failure: { code: "SEARCH_FAILED" } }] });
      await assert.rejects(fixture.client.searchByImage(searchInput(existingTaskId)), (error) => {
        assert.equal(error.code, "RISK_VERIFICATION_REQUIRED");
        assert.equal(error.status, 409);
        assert.equal(error.details.taskId, existingTaskId);
        assert.notEqual(error.details.taskId, systemTaskId, "A system queue blocker must not become this product's saved task.");
        return true;
      });
      assert.deepEqual(fixture.calls.map(({ pathname, search, method }) => ({ pathname, search, method })), [
        { pathname: "/api/v1/health", search: "", method: "GET" },
        { pathname: "/api/v1/runtime", search: "", method: "GET" },
        ...(existingTaskId ? [{ pathname: `/api/v1/tasks/${currentTaskId}`, search: "", method: "GET" }] : []),
      ]);
      assert.deepEqual(fixture.images, { downloaded: 0, read: 0, references: 0, candidateDownloads: 0, cleaned: 0 });
    });
  }
}

test("explicit queue resume posts only the confirmed action after checking companion capabilities", async () => {
  const resumed = runtimePayload({ ratePolicy: { pausedReason: null, nextAllowedAt: null } });
  const fixture = clientHarness({ resumeResponse: resumed });
  assert.deepEqual(await fixture.client.resumeQueue(), resumed);
  assert.deepEqual(fixture.calls, [
    { pathname: "/api/v1/health", search: "", method: "GET", body: null },
    { pathname: "/api/v1/queue/resume", search: "", method: "POST", body: { confirmed: true } },
  ]);
  assert.equal(fixture.images.downloaded, 0);
});

for (const existingTaskId of [null, currentTaskId]) {
  test(`rate-limit cooldown stops ${existingTaskId ? "an existing" : "a new"} product without requesting manual verification or downloading its image`, async () => {
    const nextAllowedAt = "2026-09-24T02:00:00.000Z";
    const fixture = clientHarness({ runtime: runtimePayload({ ratePolicy: { pausedReason: "RATE_LIMITED", nextAllowedAt } }),
      taskResponses: [{ status: "failed", failure: { code: "RATE_LIMITED" } }] });
    await assert.rejects(fixture.client.searchByImage(searchInput(existingTaskId)), (error) => {
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.status, 429);
      assert.equal(error.details.taskId, existingTaskId);
      assert.equal(error.details.nextAllowedAt, nextAllowedAt);
      assert.doesNotMatch(error.message, /人工|验证码|图片验证/);
      return true;
    });
    assert.deepEqual(fixture.calls.map(({ pathname, search, method }) => ({ pathname, search, method })), [
      { pathname: "/api/v1/health", search: "", method: "GET" },
      { pathname: "/api/v1/runtime", search: "", method: "GET" },
      ...(existingTaskId ? [{ pathname: `/api/v1/tasks/${currentTaskId}`, search: "", method: "GET" }] : []),
    ]);
    assert.deepEqual(fixture.images, { downloaded: 0, read: 0, references: 0, candidateDownloads: 0, cleaned: 0 });
  });
}

test("a rejected queue-resume action is returned without repeating the POST", async () => {
  const fixture = clientHarness({ resumeResponse: { ok: false, error: { code: "RISK_VERIFICATION_REQUIRED", message: "Manual verification has not completed." } } });
  await assert.rejects(fixture.client.resumeQueue(), (error) => {
    assert.equal(error.code, "RISK_CONTROL");
    assert.equal(error.status, 409);
    assert.equal(error.details.code, "RISK_VERIFICATION_REQUIRED");
    return true;
  });
  assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(fixture.images.downloaded, 0);
});

for (const capability of ["persistentSearchRateLimit", "manualRiskResume"]) {
  for (const value of [undefined, false]) {
    test(`a companion with ${capability} ${value === undefined ? "missing" : "disabled"} is rejected before runtime or business requests`, async () => {
      const health = healthPayload();
      if (value === undefined) delete health.capabilities[capability];
      else health.capabilities[capability] = value;
      const search = clientHarness({ health });
      await assert.rejects(search.client.searchByImage(searchInput()), { code: "PROCUREMENT_CONSOLE_IDENTITY_MISMATCH", status: 503 });
      assert.deepEqual(search.calls.map((call) => call.pathname), ["/api/v1/health"]);
      assert.equal(search.images.downloaded, 0);
      const resume = clientHarness({ health });
      await assert.rejects(resume.client.resumeQueue(), { code: "PROCUREMENT_CONSOLE_IDENTITY_MISMATCH", status: 503 });
      assert.deepEqual(resume.calls.map((call) => call.pathname), ["/api/v1/health"]);
    });
  }
}

const uuidTaskId = "b2ed267c-8137-491e-860b-fc1e60d7f83e";
const completedTask = { status: "review_candidates", candidates: [] };
const realQuoteFixtures = Array.from({ length: 10 }, (_, index) => ({
  supplierKey: `synthetic_supplier_${index}`, supplier: { name: `Synthetic factory ${index}` },
  offerId: String(100000 + index), offerUrl: `https://detail.1688.com/offer/${100000 + index}.html`,
  imageUrl: `https://cbu01.alicdn.com/img/ibank/synthetic-${index}.jpg`, title: "Synthetic test item", price: 10 + index,
}));

for (const taskId of [currentTaskId, uuidTaskId]) {
  test(`a failed ${taskId === uuidTaskId ? "UUID" : "legacy"} task retries once under its original ID and checkpoints before confirmation`, async () => {
    const fixture = clientHarness({ taskId, taskResponses: [{ status: "failed", failure: { code: "SESSION_BUSY" } }, completedTask] });
    const saved = [];
    const result = await fixture.client.searchByImage({ ...searchInput(taskId), onTask: async id => {
      await Promise.resolve();
      saved.push(id);
      assert.equal(fixture.calls.some(call => call.method === "POST"), false);
    } });
    assert.deepEqual(saved, [taskId]);
    const posts = fixture.calls.filter(call => call.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].pathname, `/api/v1/tasks/${taskId}/confirm`);
    assert.equal(posts[0].body.confirmed, true);
    assert.equal(result.procurementTaskId, taskId);
    assert.equal(result.procurementTaskReused, true);
    assert.equal(fixture.images.cleaned, 1);
  });
}

for (const [label, runtime] of [
  ["manual risk pause", runtimePayload({ riskBlocked: 1, ratePolicy: { pausedReason: "RISK_VERIFICATION_REQUIRED", manualResumeRequired: true } })],
  ["HTTP 429 cooldown", runtimePayload({ ratePolicy: { pausedReason: "RATE_LIMITED", nextAllowedAt: "2026-09-24T02:00:00.000Z" } })],
  ["normal pacing interval", runtimePayload({ ratePolicy: { pausedReason: null, nextAllowedAt: "2026-09-24T02:00:00.000Z" } })],
  ["expired login", { ...runtimePayload(), auth: { ready: false, reason: "login_required" } }],
]) {
  test(`completed candidates are consumed during ${label} without creating, confirming, or resuming a search`, async () => {
    const fixture = clientHarness({ runtime, taskId: uuidTaskId, candidates: realQuoteFixtures });
    const saved = [];
    const result = await fixture.client.searchByImage({ ...searchInput(uuidTaskId), onTask: async id => { saved.push(id); } });
    assert.deepEqual(saved, [uuidTaskId]);
    assert.equal(result.status, "complete");
    assert.equal(result.quotes.length, 10);
    assert.equal(result.audit.searchAttempts, 0);
    assert.equal(result.audit.onlineAuthRequired, false);
    assert.equal(fixture.calls.every(call => call.method === "GET"), true);
    assert.equal(fixture.calls.some(call => call.search.includes("verify")), false);
    assert.equal(fixture.images.candidateDownloads, 10);
    assert.equal(fixture.images.cleaned, 1);
  });
}

for (const status of ["queued", "running"]) {
  test(`an existing ${status} task is polled without confirming again during its normal pacing interval`, async () => {
    const fixture = clientHarness({ taskResponses: [{ status }, completedTask],
      runtime: runtimePayload({ ratePolicy: { pausedReason: null, nextAllowedAt: "2026-09-24T02:00:00.000Z" } }) });
    await fixture.client.searchByImage(searchInput(currentTaskId));
    assert.equal(fixture.calls.some(call => call.method === "POST"), false);
    assert.equal(fixture.calls.filter(call => call.pathname === `/api/v1/tasks/${currentTaskId}`).length, 2);
  });
}

test("an existing pending_review task is confirmed under the saved ID without replacement", async () => {
  const fixture = clientHarness({ taskResponses: [{ status: "pending_review" }, completedTask] });
  await fixture.client.searchByImage(searchInput(currentTaskId));
  assert.deepEqual(fixture.calls.filter(call => call.method === "POST").map(call => call.pathname), [`/api/v1/tasks/${currentTaskId}/confirm`]);
});

test("normal persisted nextAllowedAt prevents a failed task from being requeued early", async () => {
  const fixture = clientHarness({ taskResponses: [{ status: "failed", failure: { code: "SEARCH_FAILED" } }],
    runtime: runtimePayload({ ratePolicy: { pausedReason: null, nextAllowedAt: "2026-09-24T02:00:00.000Z" } }) });
  await assert.rejects(fixture.client.searchByImage(searchInput(currentTaskId)), { code: "RATE_LIMITED" });
  assert.equal(fixture.calls.some(call => call.method === "POST"), false);
  assert.equal(fixture.images.downloaded, 0);
});

test("a manualResumeRequired flag independently blocks failed task retry", async () => {
  const fixture = clientHarness({ taskResponses: [{ status: "failed" }],
    runtime: runtimePayload({ ratePolicy: { pausedReason: null, manualResumeRequired: true } }) });
  await assert.rejects(fixture.client.searchByImage(searchInput(currentTaskId)), { code: "RISK_VERIFICATION_REQUIRED" });
  assert.equal(fixture.calls.some(call => call.method === "POST"), false);
});

test("a risk_blocked task is never implicitly confirmed even if the runtime summary is stale", async () => {
  const fixture = clientHarness({ taskResponses: [{ status: "risk_blocked", failure: { code: "RISK_VERIFICATION_REQUIRED" } }] });
  await assert.rejects(fixture.client.searchByImage(searchInput(currentTaskId)), { code: "RISK_CONTROL" });
  assert.equal(fixture.calls.some(call => call.method === "POST"), false);
  assert.equal(fixture.images.downloaded, 0);
});

test("runtime is checked again before confirming a failed task if a pause appeared during checkpointing", async () => {
  const fixture = clientHarness({ taskResponses: [{ status: "failed" }],
    runtime: read => read === 1 ? runtimePayload() : runtimePayload({ ratePolicy: { pausedReason: "RISK_VERIFICATION_REQUIRED" } }) });
  await assert.rejects(fixture.client.searchByImage({ ...searchInput(currentTaskId), onTask: async () => {} }), { code: "RISK_VERIFICATION_REQUIRED" });
  assert.equal(fixture.calls.some(call => call.method === "POST"), false);
  assert.equal(fixture.images.cleaned, 1);
});

test("a new task checkpoint is awaited after creation and before confirmation", async () => {
  const fixture = clientHarness({ taskId: uuidTaskId });
  let finishCheckpoint;
  let enteredCheckpoint;
  const checkpointEntered = new Promise(resolve => { enteredCheckpoint = resolve; });
  const pending = fixture.client.searchByImage({ ...searchInput(), onTask: async id => {
    assert.equal(id, uuidTaskId);
    enteredCheckpoint();
    await new Promise(resolve => { finishCheckpoint = resolve; });
  } });
  await checkpointEntered;
  assert.deepEqual(fixture.calls.filter(call => call.method === "POST").map(call => call.pathname), ["/api/v1/tasks"]);
  finishCheckpoint();
  const result = await pending;
  assert.equal(result.procurementTaskId, uuidTaskId);
  assert.deepEqual(fixture.calls.filter(call => call.method === "POST").map(call => call.pathname), ["/api/v1/tasks", `/api/v1/tasks/${uuidTaskId}/confirm`]);
});

for (const existing of [false, true]) {
  test(`a failed ${existing ? "existing" : "new"} task checkpoint preserves its UUID and does not confirm or create a replacement`, async () => {
    const fixture = clientHarness({ taskId: uuidTaskId });
    await assert.rejects(fixture.client.searchByImage({ ...searchInput(existing ? uuidTaskId : null),
      onTask: async () => { throw new Error("Synthetic durable checkpoint failure"); } }), error => {
      assert.equal(error.code, "PROCUREMENT_TASK_INTERRUPTED");
      assert.equal(error.details.taskId, uuidTaskId);
      return true;
    });
    assert.deepEqual(fixture.calls.filter(call => call.method === "POST").map(call => call.pathname), existing ? [] : ["/api/v1/tasks"]);
    assert.equal(fixture.images.cleaned, existing ? 0 : 1);
  });
}

test("an unsuccessful confirm is not repeated and retains the original task ID in the error", async () => {
  const fixture = clientHarness({ taskId: uuidTaskId, taskResponses: [{ status: "failed" }],
    confirmResponse: { ok: false, error: { code: "RISK_VERIFICATION_REQUIRED", message: "Manual verification is required." } } });
  await assert.rejects(fixture.client.searchByImage(searchInput(uuidTaskId)), error => {
    assert.equal(error.code, "RISK_CONTROL");
    assert.equal(error.details.taskId, uuidTaskId);
    return true;
  });
  assert.deepEqual(fixture.calls.filter(call => call.method === "POST").map(call => call.pathname), [`/api/v1/tasks/${uuidTaskId}/confirm`]);
});

test("a missing existing task returns its ID and never silently creates a replacement", async () => {
  const fixture = clientHarness({ taskResponses: [{ ok: false, error: { code: "PROCUREMENT_TASK_NOT_FOUND", message: "Task not found." } }] });
  await assert.rejects(fixture.client.searchByImage(searchInput(currentTaskId)), error => {
    assert.equal(error.code, "PROCUREMENT_TASK_NOT_FOUND");
    assert.equal(error.details.taskId, currentTaskId);
    return true;
  });
  assert.equal(fixture.calls.some(call => call.method === "POST"), false);
  assert.equal(fixture.images.downloaded, 0);
});
