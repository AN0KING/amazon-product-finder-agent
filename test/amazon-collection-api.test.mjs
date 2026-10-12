import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { auditAmazonProductFields } from "../lib/amazon-detail-quality.mjs";
import { AMAZON_PRODUCT_DETAIL_PARSER_VERSION } from "../lib/amazon-store-client.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const serverPath = path.join(projectRoot, "server.mjs");

async function freeLocalPort() {
  const listener = createTcpServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function callApi(origin, endpoint, { method = "GET", body } = {}) {
  const url = new URL(endpoint, origin);
  assert.equal(url.hostname, "127.0.0.1");
  assert.notEqual(url.port, "4173", "Integration tests must never target the production service.");
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method,
      headers: {
        Connection: "close",
        ...(method === "POST" ? { Origin: origin } : {}),
        ...(payload === null ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.setTimeout(5_000, () => request.destroy(new Error("Local test API timed out.")));
    request.end(payload);
  });
}

async function waitUntil(check, describe, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${describe}.`);
}

test("real local collection API preserves resumable pause and archives replaced runs without reviving them", { timeout: 45_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scout-collection-api-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  const guardPath = path.join(temporaryRoot, "deny-outbound.mjs");
  const deniedLog = path.join(temporaryRoot, "denied-outbound.log");
  const processes = [];

  async function stopServer(handle) {
    if (!handle.child.pid || handle.child.exitCode !== null || handle.child.signalCode !== null) return;
    // This handle was created by this test; no production PID is discovered or stopped.
    handle.child.kill("SIGTERM");
    let timer;
    try {
      await Promise.race([
        handle.exited,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Test child did not stop.")), 5_000); }),
      ]);
    } catch (error) {
      handle.child.kill("SIGKILL");
      await handle.exited;
      throw error;
    } finally { clearTimeout(timer); }
  }

  t.after(async () => {
    try {
      for (const handle of processes) await stopServer(handle);
      const denied = await readFile(deniedLog, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
      assert.equal(denied, "", `The server attempted an unexpected external operation:\n${denied}`);
    } finally {
      assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporaryRoot).startsWith("scout-collection-api-"));
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  // Seeded complete results must require no providers. These guards also make
  // accidental network calls or subprocess-based transports fail locally.
  await writeFile(guardPath, `
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const deny = (kind) => {
  appendFileSync(process.env.SCOUT_TEST_DENIED_LOG, kind + "\\n");
  throw Object.assign(new Error("External operations are disabled in the local API test."), { code: "TEST_EXTERNAL_OPERATION_BLOCKED" });
};
net.Socket.prototype.connect = function () { return deny("socket.connect"); };
tls.connect = function () { return deny("tls.connect"); };
globalThis.fetch = async function () { return deny("fetch"); };
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = function () { return deny("child_process." + name); };
}
syncBuiltinESMExports();
`, "utf8");

  const previousDataDirectory = process.env.SCOUT_DATA_DIR;
  process.env.SCOUT_DATA_DIR = path.join(temporaryRoot, "module-default");
  let PersistenceStore;
  try {
    ({ PersistenceStore } = await import("../lib/persistence-store.mjs"));
  } finally {
    if (previousDataDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
    else process.env.SCOUT_DATA_DIR = previousDataDirectory;
  }
  const store = new PersistenceStore({ directory: dataDirectory });
  await store.ready();
  const runId = "synthetic-api-collection";
  const asin = "B000000001";
  const raw = {
    asin, sourceAsin: asin, marketplace: "CA", currency: "CAD",
    title: "Synthetic complete product", imageUrl: "https://m.media-amazon.com/images/I/synthetic.jpg",
    currentPrice: 9.99, productWeightKg: 0.06, rating: 4.1, reviewCount: 22,
    sales30: 100, sales30Evidence: { source: "amazon_product_page", asin, period: "past_month", kind: "lower_bound", value: 100, rawText: "100+ bought in past month" },
    detailStatus: "success", detailParserVersion: AMAZON_PRODUCT_DETAIL_PARSER_VERSION, detailRetryable: false,
    detailErrorCode: null, detailError: null, collectedAt: "2026-09-24T01:00:00.000Z",
    sourceTool: "amazon_product_page", dataSource: "amazon-product-page",
    fieldSources: { currentPrice: "amazon_product_page", productWeightKg: "amazon_product_page" },
    priceEvidence: { asin, currency: "CAD", source: "visible_main_price", rawText: "$9.99", selector: "#corePrice_feature_div .priceToPay" },
  };
  assert.deepEqual(auditAmazonProductFields(raw).requiredMissing, []);
  await store.saveSnapshot({
    runState: { id: runId, marketplace: "CA", currency: "CAD", amazonDomain: "www.amazon.ca", analysisSourceMode: "amazon_only", mode: "live", criteria: { useSellerSprite: false } },
    products: [],
    storeList: { stores: [{ sellerId: "TESTSELLER01", asins: [asin], rowNumbers: [2] }], audit: { marketplace: "CA" } },
  });
  await store.appendSearchBatch(runId, {
    phase: "analyze", marketplace: "CA", status: "completed", productCount: 1,
    response: { items: [raw] },
  });
  await store.saveAmazonStoreCheckpoint(runId, { marketplace: "CA", sellerId: "TESTSELLER01", asins: [asin],
    salesByAsin: { [asin]: { sales30: 100, rawText: "100+ bought in past month" } },
    complete: true, status: "complete", pagesVisited: 1, reportedTotalAsins: 1, notEnumeratedAsins: 0 });
  const staleSnapshot = await store.getRunSnapshot(runId);
  const replacementRunId = "synthetic-api-new-upload";
  await store.saveSnapshot({
    runState: { id: replacementRunId, marketplace: "CA", currency: "CAD", amazonDomain: "www.amazon.ca", analysisSourceMode: "amazon_only", mode: "live", criteria: { useSellerSprite: false } },
    products: [],
    storeList: { stores: [{ sellerId: "TESTSELLER02", asins: [asin], rowNumbers: [2] }], audit: { marketplace: "CA" } },
  });
  await store.appendSearchBatch(replacementRunId, {
    phase: "analyze", marketplace: "CA", status: "completed", productCount: 1,
    response: { items: [raw] },
  });
  await store.saveAmazonStoreCheckpoint(replacementRunId, { marketplace: "CA", sellerId: "TESTSELLER02", asins: [asin],
    salesByAsin: { [asin]: { sales30: 100, rawText: "100+ bought in past month" } },
    complete: true, status: "complete", pagesVisited: 1, reportedTotalAsins: 1, notEnumeratedAsins: 0 });

  async function startServer() {
    const port = await freeLocalPort();
    assert.notEqual(port, 4173);
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["--import", pathToFileURL(guardPath).href, serverPath], {
      cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SCOUT_MONITOR_ENABLED: "0", SCOUT_DATA_DIR: dataDirectory, SCOUT_PORT: String(port), SCOUT_TEST_DENIED_LOG: deniedLog },
    });
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-4_000); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-4_000); });
    const exited = new Promise(resolve => child.once("exit", resolve));
    const handle = { child, exited, origin };
    processes.push(handle);
    let spawnError;
    child.once("error", error => { spawnError = error; });
    await waitUntil(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Test server exited before readiness: ${output}`);
      try {
        const response = await callApi(origin, "/api/version");
        return response.status === 200 && response.body.ok;
      } catch (error) {
        if (["ECONNREFUSED", "ECONNRESET"].includes(error.code)) return false;
        throw error;
      }
    }, "the isolated local server");
    return handle;
  }

  const supplierRunId = 'synthetic-api-supplier';
  const matchedId = 'CA:B000000101';
  const newId = 'CA:B000000102';
  const originalTask = { status: 'complete', taskId: 'task_already_matched', attempts: 1, failureCount: 0 };
  await store.saveSnapshot({
    runState: { id: supplierRunId, marketplace: 'CA', currency: 'CAD', mode: 'live',
      supplier1688Pipeline: { owner: 'server', enabled: false, status: 'complete', revision: 263,
        selectionId: 'keep-original-selection', productIds: [matchedId], selectedCount: 1, matchableCount: 1,
        tasks: { [matchedId]: originalTask } } },
    products: [
      { id: matchedId, asin: 'B000000101', marketplace: 'CA', supplierSearchStatus: 'manual_cost', manualPurchaseCost: true, purchaseCost: 8, purchaseUnitCostCny: 8, imageUrl: raw.imageUrl },
      { id: newId, asin: 'B000000102', marketplace: 'CA', supplierSearchStatus: 'not_started', imageUrl: raw.imageUrl,
        sales30: 100, sales30Evidence: { ...raw.sales30Evidence, asin: 'B000000102' } },
    ],
  });
  await store.setActiveSupplierRunId(supplierRunId);

  const first = await startServer();
  const policyAsset = await fetch(first.origin + "/lib/amazon-sales-policy.mjs");
  assert.equal(policyAsset.status, 200);
  assert.match(await policyAsset.text(), /hasQualifyingAmazonMonthlySales/);
  assert.equal((await callApi(first.origin, "/api/amazon/collection")).body.data, null);
  const started = await callApi(first.origin, "/api/amazon/collection/start", { method: "POST", body: { runId } });
  assert.equal(started.status, 202);
  assert.equal(started.body.data.owner, "server");
  assert.equal(started.body.data.runId, runId);
  assert.equal(started.body.data.counts.complete, 1);
  const finished = await waitUntil(async () => {
    const response = await callApi(first.origin, "/api/amazon/collection");
    return response.body.data?.status === "completed" && !response.body.data.workerActive ? response.body.data : false;
  }, "the seeded collection to finish without provider requests");
  assert.equal(finished.counts.total, 1);
  assert.equal(finished.counts.complete, 1);
  assert.equal(finished.quality.price.verified, 1);

  const latest = (await callApi(first.origin, `/api/runs/${runId}`)).body.data;
  assert.ok(latest.runState.amazonCollectionRevision >= started.body.data.revision);
  assert.equal(latest.amazonCollection.owner, "server");
  assert.equal(latest.amazonCollection.items.length, 1);
  assert.equal(latest.products.length, 1);
  assert.equal(latest.products[0].currentPrice, 9.99);
  assert.equal(latest.products[0].collectionQuality.status, "complete");
  assert.deepEqual(latest.products[0].collectionQuality.requiredMissing, []);
  assert.equal(latest.products[0].priceEvidence.asin, asin);
  const staleWrite = await callApi(first.origin, "/api/runs", { method: "POST", body: staleSnapshot });
  assert.equal(staleWrite.status, 409);
  assert.equal(staleWrite.body.error.code, "STALE_COLLECTION_SNAPSHOT");
  latest.products[0].manualPurchaseCost = true;
  latest.products[0].purchaseCost = 457;
  latest.products[0].purchaseUnitCostCny = 457;
  latest.products[0].manualAmazonFields = { currentPrice: true };
  latest.products[0].currentPrice = 21;
  latest.products[0].manualSalePrice = true;
  latest.products[0].salePrice = 17;
  latest.products[0].manualWeight = true;
  latest.products[0].productWeight = 0.2;
  latest.products[0].billingWeight = 0.2;
  latest.products[0].supplierQuotes = [{ offerId: "saved-manual-offer", price: 457, supplierName: "Synthetic supplier" }];
  const currentWrite = await callApi(first.origin, "/api/runs", { method: "POST", body: latest });
  assert.equal(currentWrite.status, 200);

  const paused = await callApi(first.origin, "/api/amazon/collection/control", { method: "POST", body: { runId, action: "pause" } });
  assert.equal(paused.status, 202);
  assert.equal(paused.body.data.status, "paused");
  assert.equal(paused.body.data.enabled, false);
  assert.equal(paused.body.data.causeCode, "USER_PAUSED");
  const pausedSnapshot = (await callApi(first.origin, `/api/runs/${runId}`)).body.data;
  assert.equal(pausedSnapshot.runState.archivedAt, undefined, "Pause must retain a resumable run, not archive it.");
  const invalidArchive = await callApi(first.origin, `/api/runs/${runId}/archive`, { method: "POST", body: { reason: "pause" } });
  assert.equal(invalidArchive.status, 422);
  assert.equal((await callApi(first.origin, "/api/amazon/collection")).body.data.status, "paused");
  const supplierBefore = (await callApi(first.origin, '/api/1688/pipeline')).body.data;
  const invalidAppend = await callApi(first.origin, '/api/1688/pipeline/control', { method: 'POST', body: { runId: supplierRunId, action: 'append', productIds: [newId, 'CA:B000009999'] } });
  assert.equal(invalidAppend.status, 422);
  assert.equal((await callApi(first.origin, '/api/1688/pipeline')).body.data.revision, supplierBefore.revision);
  const appended = await callApi(first.origin, '/api/1688/pipeline/control', { method: 'POST', body: { runId: supplierRunId, action: 'append', productIds: [matchedId, newId, newId] } });
  assert.equal(appended.status, 200);
  assert.equal(appended.body.data.runId, supplierRunId);
  assert.equal(appended.body.data.status, 'paused');
  assert.equal(appended.body.data.enabled, false);
  assert.equal(appended.body.data.selectionId, 'keep-original-selection');
  assert.deepEqual(appended.body.data.productIds, [matchedId, newId]);
  assert.deepEqual(appended.body.data.tasks[matchedId], originalTask);
  assert.equal(appended.body.data.remaining, 1);
  assert.equal(appended.body.data.processed, 1);
  const duplicateAppend = await callApi(first.origin, '/api/1688/pipeline/control', { method: 'POST', body: { runId: supplierRunId, action: 'append', productIds: [newId] } });
  assert.equal(duplicateAppend.status, 200);
  assert.equal(duplicateAppend.body.data.revision, appended.body.data.revision);
  const supplierSnapshot = (await callApi(first.origin, `/api/runs/${supplierRunId}`)).body.data;
  assert.equal(supplierSnapshot.products[0].purchaseCost, 8);
  assert.equal((await callApi(first.origin, '/api/version')).body.data.active1688Requests, 0);
  await stopServer(first);

  const restarted = await startServer();
  const restored = (await callApi(restarted.origin, "/api/amazon/collection")).body.data;
  assert.equal(restored.status, "paused");
  assert.equal(restored.enabled, false);
  assert.equal(restored.causeCode, "USER_PAUSED");
  assert.equal(restored.workerActive, false);
  const restoredSnapshot = (await callApi(restarted.origin, `/api/runs/${runId}`)).body.data;
  assert.equal(restoredSnapshot.runState.mode, "error");
  assert.equal(restoredSnapshot.runState.amazonCollectionJob.status, "paused");
  assert.ok(restoredSnapshot.runState.amazonCollectionRevision >= paused.body.data.revision);
  assert.equal(restoredSnapshot.products[0].purchaseCost, 457);
  assert.equal(restoredSnapshot.products[0].manualPurchaseCost, true);
  assert.equal(restoredSnapshot.amazonCollection.items[0].currentPrice, 9.99);
  const resumedSupplier = (await callApi(restarted.origin, '/api/1688/pipeline')).body.data;
  assert.equal(resumedSupplier.status, 'paused');
  assert.equal(resumedSupplier.enabled, false);
  assert.equal(resumedSupplier.selectionId, 'keep-original-selection');
  assert.deepEqual(resumedSupplier.productIds, [matchedId, newId]);
  assert.deepEqual(resumedSupplier.tasks[matchedId], originalTask);
  const resumed = await callApi(restarted.origin, "/api/amazon/collection/control", { method: "POST", body: { runId, action: "resume" } });
  assert.equal(resumed.status, 202);
  assert.equal(resumed.body.data.enabled, true);
  await waitUntil(async () => {
    const response = await callApi(restarted.origin, "/api/amazon/collection");
    return response.body.data?.status === "completed" && !response.body.data.workerActive;
  }, "the manually resumed saved collection to finish");
  assert.equal((await callApi(restarted.origin, "/api/amazon/collection/control", { method: "POST", body: { runId, action: "pause" } })).status, 202);
  const beforeArchive = (await callApi(restarted.origin, `/api/runs/${runId}`)).body.data;
  assert.equal(beforeArchive.runState.archivedAt, undefined);
  const archived = await callApi(restarted.origin, `/api/runs/${runId}/archive`, { method: "POST", body: { reason: "file_upload" } });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.data.summary.id, runId);
  assert.equal(archived.body.data.summary.status, "cancelled");
  assert.ok(archived.body.data.summary.archivedAt);
  assert.equal(archived.body.data.summary.productCount, 1);
  assert.equal((await callApi(restarted.origin, "/api/amazon/collection")).body.data, null);
  const archiveSnapshot = (await callApi(restarted.origin, `/api/runs/${runId}`)).body.data;
  assert.equal(archiveSnapshot.runState.status, "cancelled");
  assert.equal(archiveSnapshot.runState.archivedAt, archived.body.data.summary.archivedAt);
  assert.equal(archiveSnapshot.runState.amazonCollectionJob.status, "cancelled");
  assert.equal(archiveSnapshot.runState.amazonCollectionJob.enabled, false);
  assert.deepEqual(archiveSnapshot.products, beforeArchive.products, "Archiving preserves derived results, manual prices, weights, costs and saved quotes.");
  assert.deepEqual(archiveSnapshot.amazonCollection.items, beforeArchive.amazonCollection.items);
  assert.equal(archiveSnapshot.products[0].currentPrice, 21);
  assert.equal(archiveSnapshot.products[0].salePrice, 17);
  assert.equal(archiveSnapshot.products[0].productWeight, 0.2);
  assert.equal(archiveSnapshot.products[0].purchaseCost, 457);
  assert.deepEqual(archiveSnapshot.products[0].supplierQuotes, latest.products[0].supplierQuotes);
  const history = (await callApi(restarted.origin, "/api/state")).body.data;
  assert.equal(history.runs.find(run => run.id === runId).status, "cancelled");
  assert.notEqual(history.latestRunId, runId, "Reload must not automatically reopen the archived run.");

  const duplicateArchive = await callApi(restarted.origin, `/api/runs/${runId}/archive`, { method: "POST", body: { reason: "file_upload" } });
  assert.equal(duplicateArchive.status, 200);
  assert.deepEqual(duplicateArchive.body.data.summary, archived.body.data.summary);
  assert.deepEqual((await callApi(restarted.origin, `/api/runs/${runId}`)).body.data, archiveSnapshot);
  const lateWrite = await callApi(restarted.origin, "/api/runs", { method: "POST", body: beforeArchive });
  assert.equal(lateWrite.status, 409);
  assert.equal(lateWrite.body.error.code, "RUN_ARCHIVED");
  const oldStart = await callApi(restarted.origin, "/api/amazon/collection/start", { method: "POST", body: { runId } });
  assert.equal(oldStart.status, 409);
  assert.equal(oldStart.body.error.code, "RUN_ARCHIVED");
  const oldResume = await callApi(restarted.origin, "/api/amazon/collection/control", { method: "POST", body: { runId, action: "resume" } });
  assert.ok(oldResume.status >= 400 && oldResume.status < 500);
  assert.equal((await callApi(restarted.origin, "/api/amazon/collection")).body.data, null);

  // A different paused supplier run must remain untouched until it, too, is replaced.
  assert.equal((await callApi(restarted.origin, "/api/1688/pipeline")).body.data.status, "paused");
  const supplierArchived = await callApi(restarted.origin, `/api/runs/${supplierRunId}/archive`, { method: "POST", body: { reason: "file_upload" } });
  assert.equal(supplierArchived.status, 200);
  assert.equal((await callApi(restarted.origin, "/api/1688/pipeline")).body.data, null);
  const archivedSupplierSnapshot = (await callApi(restarted.origin, `/api/runs/${supplierRunId}`)).body.data;
  assert.equal(archivedSupplierSnapshot.runState.supplier1688Pipeline.status, "cancelled");
  assert.equal(archivedSupplierSnapshot.runState.supplier1688Pipeline.enabled, false);
  assert.deepEqual(archivedSupplierSnapshot.runState.supplier1688Pipeline.tasks[matchedId], originalTask);
  assert.equal(archivedSupplierSnapshot.products[0].purchaseCost, 8);
  const oldSupplierResume = await callApi(restarted.origin, "/api/1688/pipeline/control", { method: "POST", body: { runId: supplierRunId, action: "resume" } });
  assert.equal(oldSupplierResume.status, 409);
  assert.equal(oldSupplierResume.body.error.code, "RUN_ARCHIVED");
  await stopServer(restarted);

  const afterArchiveRestart = await startServer();
  assert.equal((await callApi(afterArchiveRestart.origin, "/api/amazon/collection")).body.data, null);
  assert.equal((await callApi(afterArchiveRestart.origin, "/api/1688/pipeline")).body.data, null);
  assert.deepEqual((await callApi(afterArchiveRestart.origin, `/api/runs/${runId}`)).body.data, archiveSnapshot);
  const replacement = await callApi(afterArchiveRestart.origin, "/api/amazon/collection/start", { method: "POST", body: { runId: replacementRunId } });
  assert.equal(replacement.status, 202);
  assert.equal(replacement.body.data.runId, replacementRunId);
  const replacementFinished = await waitUntil(async () => {
    const response = await callApi(afterArchiveRestart.origin, "/api/amazon/collection");
    return response.body.data?.status === "completed" && !response.body.data.workerActive ? response.body.data : false;
  }, "the independent replacement run to finish");
  assert.equal(replacementFinished.counts.complete, 1);
  const replacementSnapshot = (await callApi(afterArchiveRestart.origin, `/api/runs/${replacementRunId}`)).body.data;
  assert.equal(replacementSnapshot.products[0].currentPrice, 9.99);
  assert.notEqual(replacementSnapshot.products[0].purchaseCost, 457, "The new run must not inherit manual values from the archived run.");
  assert.deepEqual((await callApi(afterArchiveRestart.origin, `/api/runs/${runId}`)).body.data, archiveSnapshot);
  await stopServer(afterArchiveRestart);
});
