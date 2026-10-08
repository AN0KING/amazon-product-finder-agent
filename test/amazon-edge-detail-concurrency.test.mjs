import test from "node:test";
import assert from "node:assert/strict";
import { createAmazonStoreSession } from "../lib/amazon-store-client.mjs";
import { EdgeCdpSession } from "../lib/amazon-edge-cdp.mjs";

const prices = new Map([["B0FPQN6JGG", 7.49], ["B0FMXKRXQ9", 11.89]]);
const asins = [...prices.keys()];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const html = (asin) => `<input id="ASIN" value="${asin}"><h1 id="productTitle">Product ${asin}</h1>
  <div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">$${prices.get(asin)}</span></span></div>`;
const getDetail = (session, asin, signal) => session.fetchProductDetailWithEdgeCdp(`https://www.amazon.ca/dp/${asin}`, asin, signal);

async function mockedSession(t, { openGate, readGate, failingAsin } = {}) {
  const calls = { opens: 0, regions: 0, navigations: [], reads: [], openStarted: deferred(), readStarted: deferred() };
  t.mock.method(EdgeCdpSession.prototype, "open", async function () {
    calls.opens += 1;
    calls.openStarted.resolve();
    if (openGate) await openGate.promise;
  });
  t.mock.method(EdgeCdpSession.prototype, "navigateUntilSettled", async function (url) {
    const asin = new URL(url).pathname.match(/^\/dp\/([A-Z0-9]{10})$/)?.[1];
    this.mockAsin = asin;
    if (asin) {
      calls.navigations.push(asin);
      if (asin === failingAsin) throw new Error("mock navigation failed");
    }
    return { url, byteLength: 100 };
  });
  t.mock.method(EdgeCdpSession.prototype, "fetchInPage", async function () {
    calls.regions += 1;
    return { status: 200, body: JSON.stringify({ isValidAddress: true, isAddressUpdated: true, successful: true,
      address: { zipCode: "M5V 2T6", countryCode: "CA" } }) };
  });
  t.mock.method(EdgeCdpSession.prototype, "pageHtml", async function () {
    calls.readStarted.resolve();
    if (readGate) await readGate.promise;
    calls.reads.push(this.mockAsin);
    return html(this.mockAsin);
  });
  t.mock.method(EdgeCdpSession.prototype, "close", async function () {});
  const unexpectedTransport = async () => { throw new Error("Unexpected network request"); };
  const session = await createAmazonStoreSession("CA", {
    executeFetch: unexpectedTransport, executeRequest: unexpectedTransport, executeBrowser: unexpectedTransport,
    executeCrossMarketFetch: false, edgeExecutable: "C:/mock/msedge.exe", requestIntervalMs: 0,
  });
  t.after(() => session.close());
  return { session, calls };
}

test("concurrent CDP product fallbacks open one browser and initialize the region once", async (t) => {
  const openGate = deferred();
  const { session, calls } = await mockedSession(t, { openGate });
  const pending = asins.map((asin) => getDetail(session, asin));
  await calls.openStarted.promise;
  await Promise.resolve();
  assert.equal(calls.opens, 1);
  openGate.resolve();
  const details = await Promise.all(pending);
  assert.deepEqual(details.map(({ asin, currentPrice }) => [asin, currentPrice]), [...prices]);
  assert.equal(calls.opens, 1);
  assert.equal(calls.regions, 1);
});

test("a shared tab cannot navigate to the next ASIN before the previous DOM read finishes", async (t) => {
  const readGate = deferred();
  const { session, calls } = await mockedSession(t, { readGate });
  await session.ensureEdgeCdpSession();
  const first = getDetail(session, asins[0]);
  await calls.readStarted.promise;
  const second = getDetail(session, asins[1]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.navigations, [asins[0]]);
  readGate.resolve();
  const details = await Promise.all([first, second]);
  assert.deepEqual(details.map(({ asin, currentPrice }) => [asin, currentPrice]), [...prices]);
  assert.deepEqual(calls.reads, asins);
});

test("a failed CDP navigation does not block the next queued product", async (t) => {
  const { session, calls } = await mockedSession(t, { failingAsin: asins[0] });
  const results = await Promise.allSettled(asins.map((asin) => getDetail(session, asin)));
  assert.equal(results[0].status, "rejected");
  assert.match(results[0].reason.message, /mock navigation failed/);
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[1].value.asin, asins[1]);
  assert.equal(results[1].value.currentPrice, prices.get(asins[1]));
  assert.equal(calls.opens, 1);
  assert.equal(calls.regions, 1);
});

test("an aborted queued product never navigates and does not block later work", async (t) => {
  const readGate = deferred();
  const { session, calls } = await mockedSession(t, { readGate });
  const first = getDetail(session, asins[0]);
  await calls.readStarted.promise;
  const controller = new AbortController();
  const aborted = getDetail(session, asins[1], controller.signal);
  controller.abort(new Error("cancel queued detail"));
  const later = getDetail(session, asins[0]);
  readGate.resolve();
  const results = await Promise.allSettled([first, aborted, later]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /cancel queued detail/);
  assert.equal(results[2].status, "fulfilled");
  assert.deepEqual(calls.navigations, [asins[0], asins[0]]);
});

test("closing a session prevents queued CDP navigation", async (t) => {
  const readGate = deferred();
  const { session, calls } = await mockedSession(t, { readGate });
  const first = getDetail(session, asins[0]);
  await calls.readStarted.promise;
  const second = getDetail(session, asins[1]);
  await session.close();
  readGate.resolve();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every((result) => result.status === "rejected" && result.reason.code === "AMAZON_SESSION_CLOSED"));
  assert.deepEqual(calls.navigations, [asins[0]]);
});
