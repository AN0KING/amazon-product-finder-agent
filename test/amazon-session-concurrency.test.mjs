import test from "node:test";
import assert from "node:assert/strict";
import { createAmazonStoreSession } from "../lib/amazon-store-client.mjs";

const prices = new Map([["B0FPQN6JGG", 7.49], ["B0FMXKRXQ9", 11.89], ["B0FMY2PV3Q", 11.99]]);
const asins = [...prices.keys()];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const productHtml = (asin) => `<!doctype html><html><body>
  <input id="ASIN" value="${asin}"><h1 id="productTitle">Synthetic product ${asin}</h1>
  <div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay">
    <span class="a-offscreen">$${prices.get(asin).toFixed(2)}</span>
  </span></div></body></html>`;

function transport({ homeGate = null, regionGate = null, failHome = () => false } = {}) {
  const calls = { home: 0, region: 0, products: [], homeStarted: deferred(), regionStarted: deferred() };
  const executeFetch = async (url, options) => {
    const target = new URL(url);
    if (target.pathname === "/") {
      calls.home += 1;
      calls.homeStarted.resolve();
      if (homeGate) await homeGate.promise;
      const status = failHome(calls.home);
      return new Response(status ? "failed initialization" : "<html>Amazon home</html>", {
        status: status || 200,
        headers: { "set-cookie": `session-id=session-${calls.home}; Path=/` },
      });
    }
    if (target.pathname === "/gp/delivery/ajax/address-change.html") {
      calls.region += 1;
      calls.regionStarted.resolve();
      assert.equal(options.method, "POST");
      assert.match(options.headers.Cookie || "", new RegExp(`session-id=session-${calls.home}(?:;|$)`));
      if (regionGate) await regionGate.promise;
      return new Response(JSON.stringify({ isValidAddress: true, isAddressUpdated: true, successful: true,
        address: { zipCode: "M5V 2T6", countryCode: "CA" } }), {
        headers: { "set-cookie": "delivery-region=CA-M5V2T6; Path=/" },
      });
    }
    const asin = target.pathname.match(/^\/dp\/([A-Z0-9]{10})$/)?.[1];
    assert.ok(prices.has(asin), `Unexpected mocked request: ${url}`);
    assert.match(options.headers.Cookie || "", new RegExp(`session-id=session-${calls.home}(?:;|$)`));
    assert.match(options.headers.Cookie || "", /delivery-region=CA-M5V2T6(?:;|$)/);
    calls.products.push(asin);
    return new Response(productHtml(asin));
  };
  return { calls, executeFetch };
}

async function openSession(mock, t) {
  const unexpectedTransport = async () => { throw new Error("Unexpected external transport"); };
  const session = await createAmazonStoreSession("CA", {
    executeFetch: mock.executeFetch,
    executeRequest: unexpectedTransport,
    executeBrowser: unexpectedTransport,
    executeCrossMarketFetch: false,
    edgeExecutable: false,
    requestIntervalMs: 0,
  });
  t.after(() => session.close());
  return session;
}

function assertProducts(details) {
  assert.deepEqual(details.map((item) => [item.asin, item.currentPrice]), [...prices]);
  assert.ok(details.every((item) => item.deliveryRegionReady === true));
}

test("three product workers share one homepage and delivery-region initialization", async (t) => {
  const homeGate = deferred();
  const mock = transport({ homeGate });
  const session = await openSession(mock, t);
  const pending = asins.map((asin) => session.getProductDetail(asin));
  await mock.calls.homeStarted.promise;
  assert.equal(mock.calls.home, 1);
  assert.equal(mock.calls.region, 0);
  homeGate.resolve();
  assertProducts(await Promise.all(pending));
  assert.equal(mock.calls.home, 1);
  assert.equal(mock.calls.region, 1);
  assert.equal(session.fetchInitializationPromise, null);
});

test("failed shared initialization clears partial cookies and allows a later recovery", async (t) => {
  let failing = true;
  const mock = transport({ failHome: () => failing ? 401 : false });
  const session = await openSession(mock, t);
  const failed = await Promise.allSettled(asins.map((asin) => session.getProductDetail(asin)));
  assert.ok(failed.every((result) => result.status === "rejected" && result.reason.code === "AMAZON_HTTP_401"));
  assert.equal(mock.calls.home, 1);
  assert.equal(mock.calls.region, 0);
  assert.equal(session.fetchInitialized, false);
  assert.equal(session.fetchInitializationPromise, null);
  assert.equal(session.fetchCookies.size, 0);
  failing = false;
  assertProducts(await Promise.all(asins.map((asin) => session.getProductDetail(asin))));
  assert.equal(mock.calls.home, 2);
  assert.equal(mock.calls.region, 1);
});

test("a reset during initialization joins that initialization without clearing its cookie jar", async (t) => {
  const regionGate = deferred();
  const mock = transport({ regionGate });
  const session = await openSession(mock, t);
  const pending = asins.slice(0, 2).map((asin) => session.getProductDetail(asin));
  await mock.calls.regionStarted.promise;
  session.resetFetchSession();
  assert.equal(session.fetchCookies.get("session-id"), "session-1");
  pending.push(session.getProductDetail(asins[2]));
  regionGate.resolve();
  assertProducts(await Promise.all(pending));
  assert.equal(mock.calls.home, 1);
  assert.equal(mock.calls.region, 1);
  session.resetFetchSession();
  assert.equal(session.fetchInitialized, false);
  assert.equal(session.fetchCookies.size, 0);
  assert.equal((await session.getProductDetail(asins[0])).currentPrice, 7.49);
  assert.equal(mock.calls.home, 2);
  assert.equal(mock.calls.region, 2);
});

test("parallel automatic retries share one replacement initialization after transient failure", async (t) => {
  const mock = transport({ failHome: (count) => count <= 3 ? 503 : false });
  const session = await openSession(mock, t);
  assertProducts(await Promise.all(asins.map((asin) => session.getProductDetail(asin))));
  // The request layer made three attempts in the failed shared initializer;
  // all workers then shared a single successful replacement initializer.
  assert.equal(mock.calls.home, 4);
  assert.equal(mock.calls.region, 1);
  assert.equal(session.fetchInitializationPromise, null);
});

function delayedFirstProduct({ holdBody = false } = {}) {
  const mock = transport();
  const executeFetch = mock.executeFetch;
  const started = deferred();
  const release = deferred();
  let held = false;
  mock.executeFetch = async (url, options) => {
    const response = await executeFetch(url, options);
    if (!new URL(url).pathname.startsWith("/dp/") || held) return response;
    held = true;
    const headers = new Headers({ "set-cookie": "session-id=stale-session; Path=/" });
    if (holdBody) {
      return {
        status: 200, headers, body: {},
        async arrayBuffer() {
          started.resolve();
          await release.promise;
          return new TextEncoder().encode(productHtml(asins[0])).buffer;
        },
      };
    }
    started.resolve();
    await release.promise;
    return new Response(productHtml(asins[0]), { headers });
  };
  return { ...mock, started, release };
}

for (const holdBody of [false, true]) {
  test(`a stale ${holdBody ? "body" : "header"} response cannot overwrite or impersonate a rebuilt session`, async (t) => {
    const mock = delayedFirstProduct({ holdBody });
    const session = await openSession(mock, t);
    await session.ensureFetchInitialized();
    const pending = session.requestWithFetch(`https://www.amazon.ca/dp/${asins[0]}`);
    const rejected = assert.rejects(pending, { code: "AMAZON_FETCH_SESSION_CHANGED" });
    await mock.started.promise;
    session.resetFetchSession();
    await session.ensureFetchInitialized();
    const newCookies = [...session.fetchCookies];
    assert.equal(session.fetchCookies.get("session-id"), "session-2");
    mock.release.resolve();
    await rejected;
    assert.deepEqual([...session.fetchCookies], newCookies);
    assert.equal(session.fetchInitialized, true);
    assert.equal(session.deliveryRegionReady.has("fetch"), true);
    assert.equal(mock.calls.home, 2);
    assert.equal(mock.calls.region, 2);
    assert.equal(mock.calls.products.length, 1, "The request layer must expose the stale-session error without retrying itself.");
  });
}

test("a stale product response retries once using the replacement session without resetting it again", async (t) => {
  const mock = delayedFirstProduct();
  const session = await openSession(mock, t);
  const pending = session.getProductDetail(asins[0]);
  await mock.started.promise;
  session.resetFetchSession();
  await session.ensureFetchInitialized();
  const newGeneration = session.fetchSessionGeneration;
  mock.release.resolve();
  const detail = await pending;
  assert.equal(detail.currentPrice, prices.get(asins[0]));
  assert.equal(detail.deliveryRegionReady, true);
  assert.equal(session.fetchSessionGeneration, newGeneration);
  assert.equal(session.fetchCookies.get("session-id"), "session-2");
  assert.equal(mock.calls.home, 2);
  assert.equal(mock.calls.region, 2);
  assert.equal(mock.calls.products.length, 2);
  await session.getProductDetail(asins[1]);
  assert.equal(mock.calls.products.length, 3, "A normal page still needs only one product request.");
  assert.equal(mock.calls.home, 2);
});

test("repeated session changes exhaust the existing product retry bound without keeping stale cookies", async (t) => {
  const mock = transport();
  const executeFetch = mock.executeFetch;
  let session;
  mock.executeFetch = async (url, options) => {
    const response = await executeFetch(url, options);
    if (!new URL(url).pathname.startsWith("/dp/")) return response;
    session.resetFetchSession();
    await session.ensureFetchInitialized();
    return new Response(productHtml(asins[0]), { headers: { "set-cookie": "session-id=stale-session; Path=/" } });
  };
  session = await openSession(mock, t);
  await assert.rejects(session.getProductDetail(asins[0]), { code: "AMAZON_FETCH_SESSION_CHANGED" });
  assert.equal(mock.calls.products.length, 2);
  assert.equal(mock.calls.home, 3);
  assert.equal(mock.calls.region, 3);
  assert.equal(session.fetchCookies.get("session-id"), "session-3");
  assert.equal(session.fetchInitialized, true);
  assert.equal(session.deliveryRegionReady.has("fetch"), true);
});
