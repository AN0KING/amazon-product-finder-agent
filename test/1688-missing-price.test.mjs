import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

import { Procurement1688Client } from "../lib/1688-procurement-client.mjs";
import { get1688DependencyStatus } from "../scripts/start-1688-dependency.mjs";
import { finalize1688SearchResult, search1688ByImage, validate1688ImageSearchInput } from "../server.mjs";

const bridgeSource = await readFile(new URL("../../1688-procurement-assistant-2.3.0/server.mjs", import.meta.url), "utf8");
const request = (overrides = {}) => ({
  runId: "synthetic-run", productId: "CA:B0FP55F3Q9", asin: "B0FP55F3Q9",
  imageUrl: "https://m.media-amazon.com/images/I/test.jpg", moq: 100, pieceCount: 2,
  currentPrice: null, salePrice: null, targetCostCny: null, currency: "CAD", marketplace: "CA",
  ...overrides,
});

function bridgeFunction(start, next) {
  const from = bridgeSource.indexOf(start);
  const to = bridgeSource.indexOf(next, from + start.length);
  assert.ok(from >= 0 && to > from, `Could not locate companion handler ${start}`);
  return bridgeSource.slice(from, to);
}

function companionHarness({ count = 10, score = 0.98, withoutPriceCapability = false } = {}) {
  const tasks = new Map();
  const persisted = [];
  const enqueued = [];
  const calls = [];
  const auth = { ready: true, reason: null };
  const queue = { queued: 0, running: 0, riskBlocked: 0, activeTasks: [] };
  const taskId = "task_price_optional_test";
  const candidateRows = Array.from({ length: count }, (_, index) => ({
    supplierKey: `supplier_${index}`, supplier: { name: `Synthetic factory ${index}` },
    offerId: String(100000 + index), offerUrl: `https://detail.1688.com/offer/${100000 + index}.html`,
    imageUrl: `https://cbu01.alicdn.com/img/ibank/synthetic-${index}.jpg`,
    title: "Synthetic test item", price: 10 + index,
  }));
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  // Execute the actual companion confirmation/health handlers with in-memory
  // persistence and queue adapters. Importing its entrypoint would start the
  // production port and resume saved work, which tests must never do.
  const context = vm.createContext({
    tasks, queueSequence: 0, ApiError,
    persistTask: async task => { persisted.push(structuredClone(task)); },
    enqueueTask: id => { enqueued.push(id); },
    publicTask: task => structuredClone(task), log() {},
    PRODUCT: "1688-procurement-assistant", VERSION: "2.3.0",
    LOGIN_BROKER_PROTOCOL: 5, INTEGRATION_PROTOCOL: 8, IMAGE_CANDIDATE_LIMIT: 40,
    publicAuth: () => auth, queueSummary: () => queue, process: { pid: 1 },
    startedAtIso: "2026-09-24T00:00:00.000Z", BB1688_HOME: "synthetic", PROJECT_ROOT: "synthetic",
  });
  const handlers = vm.runInContext([
    bridgeFunction("function healthPayload()", "async function handleCreateTask"),
    bridgeFunction("async function handleConfirmTask(", "async function handleRequest"),
    bridgeFunction("function sanitizeSingleLine(", "function shortMessage("),
    "({ healthPayload, handleConfirmTask })",
  ].join("\n"), context);
  const health = handlers.healthPayload();
  if (withoutPriceCapability) delete health.capabilities.imageSearchWithoutPrice;
  let downloads = 0;
  let cleanupCount = 0;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ pathname, method: options.method || "GET", body });
    let payload;
    if (pathname === "/api/v1/health") payload = health;
    else if (pathname === "/api/v1/runtime") payload = { ok: true, auth, queue };
    else if (pathname === "/api/v1/tasks" && options.method === "POST") {
      const task = { id: taskId, status: "pending_review", candidates: [] };
      tasks.set(taskId, task);
      payload = { ok: true, task: structuredClone(task) };
    } else if (pathname === `/api/v1/tasks/${taskId}/confirm`) {
      payload = await handlers.handleConfirmTask(taskId, body);
    } else if (pathname === `/api/v1/tasks/${taskId}`) {
      assert.ok(enqueued.includes(taskId), "A real confirmation handler must accept and queue the task before results are returned.");
      payload = { ok: true, task: { ...tasks.get(taskId), status: "review_candidates", updatedAt: "2026-09-24T00:00:00.000Z", candidates: candidateRows } };
    } else throw new Error(`Unexpected test request: ${pathname}`);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const client = new Procurement1688Client({
    fetchImpl,
    imageDownloader: async () => {
      downloads += 1;
      return { path: "synthetic-image", mimeType: "image/jpeg", cleanup: async () => { cleanupCount += 1; } };
    },
    readFileImpl: async () => Buffer.from("synthetic product image"),
    candidateImageDownloader: async url => ({ buffer: Buffer.from("synthetic candidate"), url }),
    imageReferenceFactory: async () => ({ compare: async () => ({ score, method: "test-image-comparison", version: "test-v1" }) }),
    waitImpl: async () => { throw new Error("No polling delay is expected for completed synthetic tasks."); },
  });
  return { client, handlers, tasks, persisted, enqueued, calls, taskId, fetchImpl, get downloads() { return downloads; }, get cleanupCount() { return cleanupCount; } };
}

test("1688 request accepts absent prices while still validating supplied amounts", () => {
  for (const empty of [null, undefined, ""]) {
    const input = validate1688ImageSearchInput(request({ currentPrice: empty, salePrice: empty, targetCostCny: empty }));
    assert.equal(input.currentPrice, null);
    assert.equal(input.salePrice, null);
    assert.equal(input.targetCostCny, null);
    assert.equal(input.pieceCount, 2);
  }
  for (const [field, code] of [["salePrice", "INVALID_SALE_PRICE"], ["targetCostCny", "INVALID_TARGET_COST"]]) {
    for (const invalid of [0, -1, "invalid", Infinity, NaN, 10_000_001]) {
      assert.throws(() => validate1688ImageSearchInput(request({ [field]: invalid })), { status: 422, code });
    }
  }
  assert.throws(() => validate1688ImageSearchInput(request({ imageUrl: "" })), { status: 422 });
  assert.throws(() => validate1688ImageSearchInput(request({ moq: 0 })), { code: "INVALID_MOQ" });
});

for (const scenario of [
  { count: 10, score: 0.98, status: "complete", average: 14.5 },
  { count: 6, score: 0.5, status: "fallback_estimate", average: 12.5 },
]) {
  test(`missing price completes ${scenario.status} image matching and preserves actual quote costs`, async () => {
    const bridge = companionHarness(scenario);
    const input = validate1688ImageSearchInput(request());
    const result = finalize1688SearchResult(await search1688ByImage(input, { client: bridge.client }), input);
    assert.equal(bridge.persisted.length, 1);
    assert.equal(bridge.persisted[0].search.sellingPrice, null);
    assert.equal(bridge.persisted[0].search.sellingPriceCurrency, "CAD");
    assert.equal(bridge.persisted[0].search.targetQuantity, 100);
    assert.equal(bridge.calls.find(call => call.pathname.endsWith("/confirm")).body.sellingPrice, null);
    assert.deepEqual(bridge.enqueued, [bridge.taskId]);
    assert.equal(result.status, scenario.status);
    assert.equal(result.quotes.length, scenario.count);
    assert.equal(result.averageCostCny, scenario.average);
    assert.equal(result.purchaseCostCny, scenario.average * 2);
    assert.equal(result.targetCostCny, null);
    assert.equal(result.thresholdCostCny, null);
    assert.equal(result.profitable, null);
    assert.equal(result.roughMargin, null);
    assert.equal(bridge.cleanupCount, 1);

    const priced = validate1688ImageSearchInput(request({ currentPrice: 35, salePrice: 31.5, targetCostCny: 100 }));
    const pricedBridge = companionHarness(scenario);
    const pricedResult = finalize1688SearchResult(await search1688ByImage(priced, { client: pricedBridge.client }), priced);
    assert.equal(pricedBridge.persisted[0].search.sellingPrice, 31.5);
    assert.equal(pricedResult.purchaseCostCny, result.purchaseCostCny);
    assert.equal(pricedResult.thresholdCostCny, 85);
    assert.equal(pricedResult.profitable, true);
    assert.equal(pricedResult.roughMargin, 100 - scenario.average * 2);
    assert.deepEqual(pricedResult.quotes.map(quote => quote.offerId), result.quotes.map(quote => quote.offerId));
  });
}

test("insufficient image quotes remain unavailable without inventing a price or procurement cost", async () => {
  const bridge = companionHarness({ count: 3 });
  const input = validate1688ImageSearchInput(request());
  const result = finalize1688SearchResult(await search1688ByImage(input, { client: bridge.client }), input);
  assert.equal(result.status, "insufficient");
  assert.equal(result.quotes.length, 3);
  assert.equal(result.averageCostCny, null);
  assert.equal(result.purchaseCostCny, null);
  assert.equal(result.thresholdCostCny, null);
  assert.equal(result.profitable, null);
  assert.equal(result.roughMargin, null);
});

test("companion confirmation accepts explicit unknown price and still rejects invalid supplied prices", async () => {
  const bridge = companionHarness();
  bridge.tasks.set(bridge.taskId, { id: bridge.taskId, status: "pending_review" });
  for (const sellingPrice of [0, -1, "invalid", Infinity, NaN]) {
    await assert.rejects(bridge.handlers.handleConfirmTask(bridge.taskId, {
      confirmed: true, sellingPrice, sellingPriceCurrency: "CAD", targetQuantity: 100,
    }), { status: 422, code: "PROCUREMENT_INPUT_INVALID" });
  }
  assert.equal(bridge.persisted.length, 0);
  assert.equal(bridge.enqueued.length, 0);
  assert.equal(bridge.tasks.get(bridge.taskId).status, "pending_review");
});

test("client rejects invalid supplied prices before downloading images or creating tasks", async () => {
  for (const sellingPrice of [0, -1, "invalid", Infinity, NaN]) {
    const bridge = companionHarness();
    await assert.rejects(bridge.client.searchByImage({ sellingPrice }), { code: "PROCUREMENT_INPUT_INVALID" });
    assert.equal(bridge.calls.length, 0);
    assert.equal(bridge.downloads, 0);
  }
});

test("an older companion is marked outdated before an unknown-price search can create an orphan task", async () => {
  const bridge = companionHarness({ withoutPriceCapability: true });
  const input = validate1688ImageSearchInput(request());
  await assert.rejects(search1688ByImage(input, { client: bridge.client }), { code: "PROCUREMENT_CONSOLE_IDENTITY_MISMATCH" });
  assert.equal(bridge.downloads, 0);
  assert.equal(bridge.tasks.size, 0);
  assert.equal(await get1688DependencyStatus({ fetchImpl: bridge.fetchImpl }), "outdated");
  assert.equal(await get1688DependencyStatus({ fetchImpl: companionHarness().fetchImpl }), "ready");
});
