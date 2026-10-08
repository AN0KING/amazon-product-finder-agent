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

test("real local collection API persists ownership, revisions, quality and manual pause across restart", { timeout: 30_000 }, async (t) => {
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
    storeList: { stores: [{ sellerId: null, asins: [asin], rowNumbers: [2] }], audit: { marketplace: "CA" } },
  });
  await store.appendSearchBatch(runId, {
    phase: "analyze", marketplace: "CA", status: "completed", productCount: 1,
    response: { items: [raw] },
  });
  const staleSnapshot = await store.getRunSnapshot(runId);

  async function startServer() {
    const port = await freeLocalPort();
    assert.notEqual(port, 4173);
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["--import", pathToFileURL(guardPath).href, serverPath], {
      cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SCOUT_DATA_DIR: dataDirectory, SCOUT_PORT: String(port), SCOUT_TEST_DENIED_LOG: deniedLog },
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

  const first = await startServer();
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
  const currentWrite = await callApi(first.origin, "/api/runs", { method: "POST", body: latest });
  assert.equal(currentWrite.status, 200);

  const paused = await callApi(first.origin, "/api/amazon/collection/control", { method: "POST", body: { runId, action: "pause" } });
  assert.equal(paused.status, 202);
  assert.equal(paused.body.data.status, "paused");
  assert.equal(paused.body.data.enabled, false);
  assert.equal(paused.body.data.causeCode, "USER_PAUSED");
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
  await stopServer(restarted);
});
