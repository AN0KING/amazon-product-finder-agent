import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { request as httpRequest } from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync, strToU8 } from "fflate";
import path from "node:path";
import os from "node:os";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function workbook(rows) {
  const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const cells = rows.map((row, index) => `<row r="${index + 1}">${row.map((value, column) => `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join("")}</row>`).join("");
  return Buffer.from(zipSync(Object.fromEntries(Object.entries({
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Stores" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`,
  }).map(([name, value]) => [name, strToU8(value)]))));
}

async function freePort() {
  const listener = createTcpServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  assert.ok(![4173, 16880].includes(port));
  return port;
}

function api(origin, endpoint, { method = "GET", body, headers = {} } = {}) {
  const url = new URL(endpoint, origin);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(!["4173", "16880"].includes(url.port));
  const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers: {
      Connection: "close", Origin: origin,
      ...(payload === null ? {} : { "Content-Type": "application/json", "Content-Length": payload.length }), ...headers,
    } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => { try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (error) { reject(error); } });
    });
    request.once("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("Isolated upload API timed out")));
    request.end(payload);
  });
}

test("ASIN upload endpoint validates whole batches and preserves the current task", { timeout: 20000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scout-upload-market-api-"));
  const guardPath = path.join(temporaryRoot, "deny-outbound.mjs");
  const deniedLog = path.join(temporaryRoot, "denied.log");
  const configPath = path.join(temporaryRoot, "empty-config.toml");
  let child, exited;
  t.after(async () => {
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        let timer;
        try {
          await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Test service did not stop")), 5000); })]);
        } catch (error) { child.kill("SIGKILL"); await exited; throw error; }
        finally { clearTimeout(timer); }
      }
      assert.equal(await readFile(deniedLog, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error)), "");
    } finally {
      assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporaryRoot).startsWith("scout-upload-market-api-"));
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
  await writeFile(configPath, "[mcp_servers]\n");
  await writeFile(guardPath, `
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const deny = kind => { appendFileSync(process.env.SCOUT_TEST_DENIED_LOG, kind + "\\n"); throw new Error("Unexpected outbound operation"); };
net.Socket.prototype.connect = () => deny("socket");
tls.connect = () => deny("tls");
globalThis.fetch = async () => deny("fetch");
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[key] = () => deny("process");
syncBuiltinESMExports();
`);
  const origin = `http://127.0.0.1:${await freePort()}`;
  child = spawn(process.execPath, ["--import", pathToFileURL(guardPath).href, path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SCOUT_MONITOR_ENABLED: "0",
      SCOUT_PORT: new URL(origin).port, SCOUT_DATA_DIR: path.join(temporaryRoot, "service-state"),
      SCOUT_SELLERSPRITE_CONFIG_PATH: configPath, SCOUT_TEST_DENIED_LOG: deniedLog,
    },
  });
  exited = new Promise(resolve => child.once("exit", resolve));
  let output = "", spawnError;
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-4000); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-4000); });
  child.once("error", error => { spawnError = error; });
  let ready = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated service exited: ${output}`);
    try { ready = (await api(origin, "/api/version")).status === 200; if (ready) break; }
    catch (error) { if (!["ECONNREFUSED", "ECONNRESET"].includes(error.code)) throw error; }
    await delay(25);
  }
  assert.equal(ready, true, output);
  const runId = "synthetic-preserved-upload-run";
  const saved = await api(origin, "/api/runs", { method: "POST", body: {
    runState: { id: runId, marketplace: "AU", currency: "AUD", amazonDomain: "www.amazon.com.au", mode: "live", analysisSourceMode: "amazon_only", criteria: { useSellerSprite: false } },
    products: [{ id: "AU:B000000001", asin: "B000000001", marketplace: "AU", manualPurchaseCost: true, purchaseCost: 8, purchaseUnitCostCny: 8 }],
    storeList: { stores: [{ sellerId: "TESTSELLER01", sellerUrl: "https://www.amazon.com.au/s?me=TESTSELLER01", marketplace: "AU", asins: [], rowNumbers: [2] }], audit: { marketplace: "AU" } },
  } });
  assert.equal(saved.status, 200);
  const initialState = await api(origin, "/api/state");
  const initialRun = await api(origin, `/api/runs/${runId}`);
  const initialCollection = await api(origin, "/api/amazon/collection");
  async function unchanged() {
    assert.deepEqual(await api(origin, "/api/state"), initialState);
    assert.deepEqual(await api(origin, `/api/runs/${runId}`), initialRun);
    assert.deepEqual(await api(origin, "/api/amazon/collection"), initialCollection);
  }
  const valid = await api(origin, '/api/asin-list/parse', { method: 'POST', body: { marketplace: 'CA', text: 'B09V6TRGTD B000000002 B09V6TRGTD' } });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
  assert.equal(valid.body.data.inputMode, 'asins');
  assert.equal(valid.body.data.audit.uniqueAsins, 2);
  assert.equal(valid.body.data.stores[0].sellerId, null);
  await unchanged();
  const excel = await api(origin, '/api/asin-list/parse', { method: 'POST', body: workbook([['ASIN', '商品链接'], ['B09V6TRGTD', 'https://amazon.ca/dp/B09V6TRGTD']]), headers: {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'X-File-Name': encodeURIComponent('直接输入.xlsx'), 'X-Marketplace': 'AU',
  } });
  assert.equal(excel.status, 200, JSON.stringify(excel.body));
  assert.equal(excel.body.data.marketplace, 'AU');
  assert.equal(excel.body.data.audit.sourceColumn, 'asin');
  await unchanged();
  const headerlessAsins = Array.from({ length: 9 }, (_, index) => `B${String(index + 1).padStart(9, '0')}`);
  const headerlessBytes = workbook(headerlessAsins.map(asin => [`https://www.amazon.com.au/dp/${asin}?m=TESTSELLER01`]));
  const headerless = await api(origin, '/api/asin-list/parse', { method: 'POST', body: headerlessBytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'nine-products.xlsx', 'X-Marketplace': 'AU' } });
  assert.equal(headerless.status, 200, JSON.stringify(headerless.body));
  assert.deepEqual(headerless.body.data.stores[0].asins, headerlessAsins);
  assert.equal(headerless.body.data.rows[0].rowNumber, 1);
  assert.equal(headerless.body.data.audit.sourceFormat, 'headerless_single_column');
  await unchanged();
  const rejectedHeaderless = await api(origin, '/api/asin-list/parse', { method: 'POST', body: workbook([
    ['https://www.amazon.com.au/dp/B000000001?m=TESTSELLER01'], ['https://www.amazon.com.au/s?me=TESTSELLER01'],
  ]), headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'invalid-products.xlsx', 'X-Marketplace': 'AU' } });
  assert.equal(rejectedHeaderless.status, 422);
  await unchanged();
  for (const text of ['B09V6TRGTD BAD', 'B09V6TRGTD https://amazon.ca/dp/B000000002', 'https://amazon.ca.evil.example/dp/B09V6TRGTD']) {
    const rejected = await api(origin, '/api/asin-list/parse', { method: 'POST', body: { marketplace: 'AU', text } });
    assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
    await unchanged();
  }
  const forbidden = await api(origin, '/api/asin-list/parse', { method: 'POST', body: { marketplace: 'AU', text: 'B09V6TRGTD' }, headers: { Origin: 'http://attacker.invalid' } });
  assert.equal(forbidden.status, 403);
  await unchanged();
  const uploadedStores = await api(origin, '/api/store-list/parse', { method: 'POST', body: workbook([
    ['sellerUrl', 'ASIN', '商品链接'],
    ['https://amazon.com.au/s?me=TESTSELLER01', 'B09V6TRGTD', 'https://amazon.ca/dp/B000000002'],
    ['https://amazon.com.au/s?me=TESTSELLER01', '', 'https://amazon.ca/dp/B000000003'],
  ]), headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'same-input.xlsx', 'X-Marketplace': 'AU' } });
  assert.equal(uploadedStores.status, 200, JSON.stringify(uploadedStores.body));
  const projection = uploadedStores.body.data.directAsinInput;
  assert.equal(projection.status, 'ready');
  assert.equal(projection.source, 'uploaded_excel_direct_products');
  assert.equal(projection.version, 1);
  assert.deepEqual(projection.data.stores[0].asins, ['B09V6TRGTD']);
  assert.equal(projection.data.stores[0].sellerId, null);
  assert.equal(projection.data.audit.skippedBlankAsinRows, 1);
  await unchanged();
  const storeModeProducts = await api(origin, '/api/store-list/parse', { method: 'POST', body: headerlessBytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'nine-products.xlsx', 'X-Marketplace': 'AU' } });
  assert.equal(storeModeProducts.status, 200, JSON.stringify(storeModeProducts.body));
  assert.equal(storeModeProducts.body.data.directAsinInput.status, 'ready');
  assert.equal(storeModeProducts.body.data.directAsinInput.source, 'uploaded_excel_direct_products');
  assert.deepEqual(storeModeProducts.body.data.directAsinInput.data.stores[0].asins, headerlessAsins);
  assert.equal(storeModeProducts.body.data.directAsinInput.data.audit.sourceFormat, 'headerless_single_column');
  await unchanged();
  const productColumn = await api(origin, '/api/store-list/parse', { method: 'POST', body: workbook([
    ['sellerUrl', '商品链接'], ['https://amazon.com.au/s?me=TESTSELLER01', 'https://amazon.com.au/dp/B09V6TRGTD'],
  ]), headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'product-column.xlsx', 'X-Marketplace': 'AU' } });
  assert.equal(productColumn.status, 200, JSON.stringify(productColumn.body));
  assert.equal(productColumn.body.data.directAsinInput.status, 'ready');
  assert.equal(productColumn.body.data.directAsinInput.data.audit.sourceColumn, 'product_url');
  assert.deepEqual(productColumn.body.data.directAsinInput.data.stores[0].asins, ['B09V6TRGTD']);
  await unchanged();
  for (const [header, value, code] of [
    ['ASIN', 'INVALID', 'INVALID_ASIN_INPUT'],
    ['商品链接', 'https://amazon.com.au/s?me=TESTSELLER01', 'INVALID_ASIN_URL'],
  ]) {
    const cannotProject = await api(origin, '/api/store-list/parse', { method: 'POST', body: workbook([
      ['sellerUrl', header], ['https://amazon.com.au/s?me=TESTSELLER01', value],
    ]), headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'legacy-store.xlsx', 'X-Marketplace': 'AU' } });
    assert.equal(cannotProject.status, 200);
    assert.equal(cannotProject.body.data.directAsinInput.status, 'unavailable');
    assert.equal(cannotProject.body.data.directAsinInput.data, null);
    assert.equal(cannotProject.body.data.directAsinInput.error.code, code);
    await unchanged();
  }
  const sellersOnly = await api(origin, '/api/store-list/parse', { method: 'POST', body: workbook([
    ['https://amazon.com.au/s?me=TESTSELLER01'], ['https://amazon.com.au/s?me=TESTSELLER02'],
  ]), headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'sellers-only.xlsx', 'X-Marketplace': 'AU' } });
  assert.equal(sellersOnly.status, 200, JSON.stringify(sellersOnly.body));
  assert.equal(sellersOnly.body.data.directAsinInput.status, 'unavailable');
  assert.equal(sellersOnly.body.data.directAsinInput.data, null);
  assert.equal(sellersOnly.body.data.directAsinInput.error.code, 'INVALID_ASIN_URL');
  await unchanged();
  const directRunId = 'synthetic-direct-history';
  const savedDirect = await api(origin, '/api/runs', { method: 'POST', body: {
    runState: { id: directRunId, marketplace: 'CA', inputMode: 'asins', mode: 'live', analysisSourceMode: 'amazon_only', criteria: { minReviews: 0, maxReviews: 100 } },
    storeList: valid.body.data, products: [],
  } });
  assert.equal(savedDirect.status, 200, JSON.stringify(savedDirect.body));
  const state = await api(origin, '/api/state');
  const history = state.body.data.runs.find(run => run.id === directRunId);
  assert.equal(history.inputMode, 'asins');
  assert.equal(history.importedAsinCount, 2);
  assert.equal(history.storeCount, 0);
  assert.deepEqual(await api(origin, `/api/runs/${runId}`), initialRun, 'Saving a new direct input must not alter another saved manual record.');
});
