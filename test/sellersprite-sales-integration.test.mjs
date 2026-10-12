import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { request as httpRequest } from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import os from "node:os";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scout-sellersprite-sales-"));
const previousDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(temporaryRoot, "module-state");
const { normalizeSellerSpriteItem, analyzeDiscoveredAsins, analyzeProductSearchDiscoveries, connectSellerSpriteForMarketplace } = await import("../server.mjs");
const { persistenceStore } = await import("../lib/persistence-store.mjs");
await persistenceStore.ready();
if (previousDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
else process.env.SCOUT_DATA_DIR = previousDirectory;
after(async () => {
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith("scout-sellersprite-sales-"));
  await rm(temporaryRoot, { recursive: true, force: true });
});

const targetAsin = "B000000001", otherAsin = "B000000002", parentAsin = "B000000003";
const collectedAt = "2026-10-12T07:00:00.000Z";
const sourceStore = { storeIndex: 0, sellerId: "TESTSELLER01", sellerName: "Synthetic shop", rowNumbers: [2] };
const context = (extra = {}) => ({ marketplace: "CA", sourceTool: "competitor_lookup", sourceStore, requestedAsin: targetAsin, collectedAt, ...extra });
const raw = (extra = {}) => ({ asin: targetAsin, marketplace: "CA", parent: parentAsin, amzUnit: 70, units: 800, ...extra });

test("target child monthly sales use amzUnit and preserve parent metrics separately", () => {
  const item = normalizeSellerSpriteItem(raw({ amzUnitDate: 1791788400000 }), context());
  assert.equal(item.sales30, 70);
  assert.equal(item.parentSales30, 800);
  assert.equal(item.sourceAsin, targetAsin);
  assert.equal(item.sales30Evidence.asin, targetAsin);
  assert.equal(item.sales30Evidence.rawAsin, targetAsin);
  assert.equal(item.sales30Evidence.field, "amzUnit");
  assert.equal(item.sales30Evidence.source, "sellsprite_api");
  assert.equal(item.sales30Evidence.marketplace, "CA");
});

test("unrelated ASINs and another marketplace cannot be assigned to the target", () => {
  assert.equal(normalizeSellerSpriteItem(raw({ asin: otherAsin }), context()), null);
  assert.equal(normalizeSellerSpriteItem(raw({ marketplace: "US" }), context()), null);
  assert.equal(normalizeSellerSpriteItem(raw({ asin: "invalid" }), context()), null);
});

test("missing child sales do not inherit a parent's units, including a self-parent record", () => {
  for (const parent of [parentAsin, targetAsin]) {
    const item = normalizeSellerSpriteItem(raw({ parent, amzUnit: null }), context());
    assert.equal(item.sales30, null);
    assert.equal(item.sales30Evidence, null);
    assert.equal(item.parentSales30, 800);
  }
  const zero = normalizeSellerSpriteItem(raw({ amzUnit: 0 }), context());
  assert.equal(zero.sales30, 0);
  assert.equal(zero.sales30Evidence.value, 0);
});

test("detail-only responses and undeclared aliases cannot supply target sales evidence", () => {
  for (const sourceTool of ["asin_detail", "asin_competitor"]) {
    assert.equal(normalizeSellerSpriteItem(raw(), context({ sourceTool })).sales30Evidence, null);
  }
  assert.equal(normalizeSellerSpriteItem(raw({ amzUnit: null, sales30: 90, units30: 100 }), context()).sales30Evidence, null);
});

let runSequence = 0;
function analysisHarness(items) {
  const calls = { details: [], lookups: [], savedBatches: [] };
  const discoveries = [{ sourceStore, asins: [targetAsin], visit: { complete: true } }];
  const input = { runId: `synthetic-sellsprite-${++runSequence}`, marketplace: "CA", phase: "analyze", useSellerSprite: true, filters: {} };
  const store = {
    getAsinDetailResults: async () => ({}), saveAsinDetailResult: async () => {},
    getCompetitorLookupResults: async () => ({}), saveCompetitorLookupBatch: async (_runId, batch) => { calls.savedBatches.push(batch); },
  };
  const options = {
    detailPersistence: store, competitorLookupPersistence: store,
    detailLoader: async (args) => { calls.details.push(args); return { asin: args.asin, marketplace: args.marketplace, title: "Synthetic detail", parent: parentAsin }; },
    competitorLookupLoader: async (args) => { calls.lookups.push(args); return { items }; },
  };
  return { calls, discoveries, input, options, run: (extra = {}) => analyzeDiscoveredAsins(discoveries, input, collectedAt, new AbortController().signal, { ...options, ...extra }) };
}

test("batch lookup merges only requested ASINs and checkpoints the selected target", async () => {
  const harness = analysisHarness([raw({ asin: otherAsin, amzUnit: 10000 }), raw()]);
  const result = await harness.run();
  assert.equal(harness.calls.lookups.length, 1);
  assert.equal(harness.calls.lookups[0].month, "nearly");
  assert.deepEqual(harness.calls.lookups[0].asins, [targetAsin]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].asin, targetAsin);
  assert.equal(result.items[0].sales30, 70);
  assert.equal(result.items[0].sales30Evidence.asin, targetAsin);
  assert.deepEqual(harness.calls.savedBatches[0].items.map(item => item.asin), [targetAsin]);
  assert.ok(result.errors.some(error => error.code === "SELLSPRITE_UNREQUESTED_ASIN"));
});

test("an account with only the monthly lookup tool collects sales without failed detail calls", async () => {
  const harness = analysisHarness([raw()]);
  const result = await harness.run({ detailAvailable: false });
  assert.equal(harness.calls.details.length, 0);
  assert.equal(harness.calls.lookups.length, 1);
  assert.equal(result.items[0].sales30, 70);
  assert.equal(result.items[0].detailStatus, "success");
  assert.equal(result.audit.detailCallsStarted, 0);
  assert.equal(result.errors.length, 0);
});

test("omitted detail tool and missing lookup data remain unknown rather than zero", async () => {
  const harness = analysisHarness([]);
  const result = await harness.run({ detailAvailable: false });
  assert.equal(harness.calls.details.length, 0);
  assert.equal(result.items[0].sales30, null);
  assert.equal(result.items[0].sales30Evidence, null);
  assert.equal(result.items[0].competitorLookupStatus, "empty");
  assert.equal(result.audit.detailCallsStarted, 0);
});

test("turning SellerSprite off never calls its analyzer or lookup loader", async () => {
  let amazonCalls = 0, sellerCalls = 0;
  const { analysis } = await analyzeProductSearchDiscoveries([{ visit: { complete: true } }],
    { marketplace: "CA", phase: "analyze", useSellerSprite: false }, collectedAt, new AbortController().signal, {
      amazonAnalyzer: async () => { amazonCalls += 1; return { items: [{ sourceTool: "amazon_product_page" }] }; },
      sellerSpriteAnalyzer: async () => { sellerCalls += 1; throw new Error("SellerSprite must stay disconnected"); },
      competitorLookupLoader: async () => { sellerCalls += 1; throw new Error("SellerSprite lookup must not run"); },
    });
  assert.equal(amazonCalls, 1);
  assert.equal(sellerCalls, 0);
  assert.equal(analysis.items[0].sourceTool, "amazon_product_page");
});

test("unsupported marketplaces are rejected before SellerSprite connection or authorization", async () => {
  let connections = 0;
  for (const marketplace of ["AU", "NL"]) {
    await assert.rejects(connectSellerSpriteForMarketplace(marketplace, { connect: async () => { connections += 1; return []; } }),
      { code: "SELLSPRITE_MARKETPLACE_UNSUPPORTED" });
  }
  assert.equal(connections, 0);
});

test("competitor lookup is sufficient to connect; detail and related competitors alone are not", async () => {
  const connected = await connectSellerSpriteForMarketplace("CA", { connect: async () => [{ name: "competitor_lookup" }] });
  assert.equal(connected.capabilities.monthlySales.available, true);
  assert.equal(connected.capabilities.detail.available, false);
  await assert.rejects(connectSellerSpriteForMarketplace("CA", { connect: async () => [{ name: "asin_detail" }, { name: "asin_competitor" }] }),
    { code: "SELLSPRITE_TOOL_UNAVAILABLE" });
});

async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.notEqual(port, 4173);
  return port;
}
function api(origin, endpoint, { method = "GET", body } = {}) {
  const url = new URL(endpoint, origin);
  assert.equal(url.hostname, "127.0.0.1"); assert.notEqual(url.port, "4173");
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers: { Connection: "close", Origin: origin,
      ...(payload === null ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }) } }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => { try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (error) { reject(error); } });
    });
    request.once("error", reject); request.setTimeout(5000, () => request.destroy(new Error("Test API timed out"))); request.end(payload);
  });
}

test("isolated local status and explicit connect gates perform no outbound requests", { timeout: 15000 }, async (t) => {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const guardPath = path.join(temporaryRoot, "deny-outbound.mjs"), deniedLog = path.join(temporaryRoot, "denied.log");
  const configPath = path.join(temporaryRoot, "missing-sellersprite.toml");
  await writeFile(configPath, "[mcp_servers]\n");
  await writeFile(guardPath, `
    import net from "node:net";
    import tls from "node:tls";
    import childProcess from "node:child_process";
    import { appendFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const deny = (kind) => { appendFileSync(process.env.SCOUT_TEST_DENIED_LOG, kind + "\\n"); throw new Error("Unexpected outbound operation"); };
    net.Socket.prototype.connect = () => deny("socket");
    tls.connect = () => deny("tls");
    globalThis.fetch = async () => deny("fetch");
    for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[key] = () => deny("process");
    syncBuiltinESMExports();
  `);
  const origin = `http://127.0.0.1:${await freePort()}`;
  const child = spawn(process.execPath, ["--import", pathToFileURL(guardPath).href, path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SCOUT_MONITOR_ENABLED: "0",
      SCOUT_PORT: new URL(origin).port, SCOUT_DATA_DIR: path.join(temporaryRoot, "service-state"),
      SCOUT_SELLERSPRITE_CONFIG_PATH: configPath, SCOUT_TEST_DENIED_LOG: deniedLog,
    },
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let output = ""; child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { output += c; });
  let spawnError; child.once("error", error => { spawnError = error; });
  t.after(async () => { child.kill("SIGTERM"); await exited; assert.equal(await readFile(deniedLog, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error)), ""); });
  const deadline = Date.now() + 7000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Isolated test service exited: ${output}`);
    try { ready = (await api(origin, "/api/version")).status === 200; if (ready) break; }
    catch (error) { if (!["ECONNREFUSED", "ECONNRESET"].includes(error.code)) throw error; }
    await delay(25);
  }
  assert.equal(ready, true, output);
  const status = await api(origin, "/api/sellsprite/status");
  assert.equal(status.status, 200); assert.equal(status.body.data.connected, false);
  assert.deepEqual(status.body.data.configuration, { configured: false, errorCode: "SELLSPRITE_CONFIG_INVALID" });
  assert.equal(status.body.data.toolCallCount, 0);
  const unconfirmed = await api(origin, "/api/sellsprite/connect", { method: "POST", body: { marketplace: "CA" } });
  assert.equal(unconfirmed.status, 422); assert.equal(unconfirmed.body.error.code, "SELLSPRITE_CONFIRMATION_REQUIRED");
  const unsupported = await api(origin, "/api/sellsprite/connect", { method: "POST", body: { confirmed: true, marketplace: "AU" } });
  assert.equal(unsupported.status, 422); assert.equal(unsupported.body.error.code, "SELLSPRITE_MARKETPLACE_UNSUPPORTED");
  const missing = await api(origin, "/api/sellsprite/connect", { method: "POST", body: { confirmed: true, marketplace: "CA" } });
  assert.equal(missing.status, 503); assert.equal(missing.body.error.code, "SELLSPRITE_CONFIG_INVALID");
  const final = await api(origin, "/api/sellsprite/status");
  assert.equal(final.body.data.connected, false); assert.equal(final.body.data.toolCallCount, 0);
  assert.equal(JSON.stringify(final.body).includes(configPath), false);
});
