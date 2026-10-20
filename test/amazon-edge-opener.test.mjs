import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { openAmazonInEdge, validateAmazonBrowserUrl } from "../lib/amazon-edge-opener.mjs";

const productUrl = "https://www.amazon.com.au/dp/B09NXS1BLL?th=1&psc=1&tag=a%2Fb#productDetails";
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

test("Amazon opens only the installed Edge executable and preserves the exact imported URL", async () => {
  const launches = [];
  let unref = false;
  const result = await openAmazonInEdge(productUrl, {
    platform: "win32", environment: {}, statImpl: async executable => ({ isFile: () => executable === edge }),
    spawnImpl(executable, args, options) {
      launches.push({ executable, args, options });
      const child = new EventEmitter();
      child.unref = () => { unref = true; };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.deepEqual(result, { opened: true, browser: "edge" });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].executable, edge);
  assert.deepEqual(launches[0].args, [productUrl]);
  assert.equal(launches[0].options.shell, false);
  assert.equal(launches[0].options.windowsHide, false);
  assert.equal(unref, true);
});

for (const url of [
  "https://www.amazon.com.au/s?me=SELLER&rh=p_6%3ASELLER",
  "https://www.amazon.com.au/sp?seller=SELLER",
  "https://www.amazon.com.au/stores/Example/page/STORE?ref_=ast_bln",
  "https://www.amazon.co.uk/product-name/gp/product/B09NXS1BLL?th=1",
  "https://www.amazon.com.au/gp/aw/d/B09NXS1BLL?th=1",
]) {
  test(`product and shop URLs share the same Edge-only validation: ${new URL(url).pathname}`, () => {
    assert.equal(validateAmazonBrowserUrl(url), url);
  });
}

for (const url of [
  "https://detail.1688.com/offer/123456.html", "https://www.amazon.com.au.evil.test/dp/B09NXS1BLL",
  "https://www.amazon.com.au@evil.test/dp/B09NXS1BLL", "https://account@www.amazon.com.au/dp/B09NXS1BLL",
  "http://www.amazon.com.au/dp/B09NXS1BLL", "https://www.amazon.com.au:9999/dp/B09NXS1BLL",
  "https://www.amazon.com.au/ap/signin", "file:///C:/Windows/system32/cmd.exe", "--user-data-dir=C:/unexpected",
  "https://www.amazon.com.au/dp/B09NXS1BLL\n--new-window", null, {},
]) {
  test(`non-Amazon, unsafe and unsupported targets are rejected before launching (${JSON.stringify(url)})`, async () => {
    let inspected = false;
    await assert.rejects(openAmazonInEdge(url, { platform: "win32",
      statImpl: async () => { inspected = true; }, spawnImpl: () => { throw new Error("Must not launch"); },
    }), { code: "INVALID_AMAZON_BROWSER_URL" });
    assert.equal(inspected, false);
  });
}

test("missing Edge does not fall back to Chrome, cmd, or the default browser", async () => {
  const inspected = [];
  let launched = false;
  await assert.rejects(openAmazonInEdge(productUrl, {
    platform: "win32", environment: { LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local", CHROME_PATH: "C:\\chrome.exe" },
    statImpl: async candidate => { inspected.push(candidate); throw new Error("Absent"); },
    spawnImpl: () => { launched = true; },
  }), { code: "EDGE_NOT_INSTALLED" });
  assert.ok(inspected.length >= 2);
  assert.ok(inspected.every(candidate => candidate.endsWith("\\Microsoft\\Edge\\Application\\msedge.exe")));
  assert.equal(launched, false);
});

test("an Edge launch error remains a failure without a second browser attempt", async () => {
  let attempts = 0;
  await assert.rejects(openAmazonInEdge(productUrl, {
    platform: "win32", environment: {}, statImpl: async () => ({ isFile: () => true }),
    spawnImpl() {
      attempts++;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("Fixture Edge launch error")));
      return child;
    },
  }), { code: "EDGE_OPEN_FAILED" });
  assert.equal(attempts, 1);
});

test("non-Windows hosts do not invoke any default browser", async () => {
  await assert.rejects(openAmazonInEdge(productUrl, {
    platform: "linux", statImpl: async () => { throw new Error("Must not inspect"); },
    spawnImpl: () => { throw new Error("Must not launch"); },
  }), { code: "EDGE_OPEN_NOT_SUPPORTED" });
});

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
function sourceFunction(name) {
  const match = serverSource.match(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(match, name);
  const end = serverSource.indexOf("\n}", match.index) + 2;
  return serverSource.slice(match.index, end);
}
function routeHarness(body, method = "POST", origin = "http://127.0.0.1:4173") {
  const calls = [];
  class HttpError extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }); } }
  const context = vm.createContext({
    URL, HttpError, ORIGIN: "http://127.0.0.1:4173", EXPECTED_HOST: "127.0.0.1:4173",
    archivingRunId: null, STATIC_FILES: new Map(), isRuntimeVerifyRequest: () => false,
    readJsonBody: async () => body,
    openAmazonInEdge: async url => { calls.push(validateAmazonBrowserUrl(url)); return { opened: true, browser: "edge" }; },
    sendJson: (_response, status, payload) => calls.push({ status, payload }),
  });
  const route = vm.runInContext(["routeRequest", "enforceLocalRequest", "requireMethod", "requireContentType", "isPlainObject"].map(sourceFunction).join("\n")
    + "\nasync (request) => { enforceLocalRequest(request); return routeRequest(request, {}, new URL('/api/amazon/open-in-edge', ORIGIN)); }", context);
  return { calls, run: () => route({ method, headers: { host: "127.0.0.1:4173", origin, "content-type": "application/json", "sec-fetch-site": "same-origin" } }) };
}

test("the actual local route requires exact local Origin and POST before invoking Edge", async () => {
  const valid = routeHarness({ url: productUrl });
  await valid.run();
  assert.equal(valid.calls[0], productUrl);
  assert.equal(valid.calls[1].payload.data.browser, "edge");
  for (const [method, origin, code] of [["GET", undefined, "METHOD_NOT_ALLOWED"], ["POST", "https://example.test", "INVALID_ORIGIN"]]) {
    const invalid = routeHarness({ url: productUrl }, method, origin);
    await assert.rejects(invalid.run(), { code });
    assert.equal(invalid.calls.length, 0);
  }
  const extra = routeHarness({ url: productUrl, executable: "chrome.exe" });
  await assert.rejects(extra.run(), { code: "INVALID_AMAZON_BROWSER_REQUEST" });
  assert.equal(extra.calls.length, 0);
});
