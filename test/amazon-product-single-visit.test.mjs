import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { load } from "cheerio";
import { createAmazonStoreSession, normalizeAmazonProductUrl, AmazonStoreError, parseAmazonProductPage } from "../lib/amazon-store-client.mjs";
import { mergeAmazonCollectionProduct } from "../lib/amazon-collection-merge.mjs";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scout-single-visit-"));
const previousDataDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(temporaryRoot, "module-default");
let analyzeAmazonDiscoveredAsins;
let PersistenceStore;
try {
  ({ analyzeAmazonDiscoveredAsins } = await import("../server.mjs"));
  ({ PersistenceStore } = await import("../lib/persistence-store.mjs"));
} finally {
  if (previousDataDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
  else process.env.SCOUT_DATA_DIR = previousDataDirectory;
}
after(async () => {
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith("scout-single-visit-"));
  await rm(temporaryRoot, { recursive: true, force: true });
});

const asin = "B0FP55F3Q9";
const canonicalUrl = `https://www.amazon.com.au/dp/${asin}`;
const imageUrl = "https://m.media-amazon.com/images/I/synthetic-main.jpg";
const html = (withPriceAndWeight = true) => `<!doctype html><html><body>
  <input id="ASIN" value="${asin}"><h1 id="productTitle">Synthetic single-visit item</h1>
  <img id="landingImage" data-old-hires="${imageUrl}" src="https://m.media-amazon.com/images/I/small.jpg">
  <div id="acrPopover" title="4.6 out of 5 stars"></div>
  <span id="acrCustomerReviewText">1,234 ratings</span>
  <span id="social-proofing-faceout-title-tk_bought">100+ bought in past month</span>
  ${withPriceAndWeight ? `<div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">$9.99</span></span></div>
  <table id="productDetails_detailBullets_sections1">
    <tr><th>Item Weight</th><td>60 g</td></tr>
    <tr><th>Package Weight</th><td>80 g</td></tr>
  </table>` : ""}
  <div id="recommendations"><img src="https://m.media-amazon.com/images/I/unrelated.jpg">
    <span class="a-price priceToPay"><span class="a-offscreen">$279.00</span></span></div>
</body></html>`;

async function mockedSession(t, { body = html(), failFirstProduct = false, edgeExecutable = false, expectedProductUrl = canonicalUrl } = {}) {
  const calls = { home: 0, region: 0, product: 0, crossMarket: 0 };
  const denyTransport = async () => { throw new Error("Unexpected external transport"); };
  const session = await createAmazonStoreSession("AU", {
    executeFetch: async (value, options) => {
      const url = new URL(value);
      assert.ok(["https://www.amazon.com.au", new URL(expectedProductUrl).origin].includes(url.origin));
      if (url.pathname === "/") {
        calls.home += 1;
        return new Response("<html>Amazon homepage</html>");
      }
      if (url.pathname === "/gp/delivery/ajax/address-change.html") {
        calls.region += 1;
        assert.equal(options.method, "POST");
        return new Response(JSON.stringify({ isValidAddress: true, isAddressUpdated: true, successful: true,
          address: { zipCode: "3010", countryCode: "AU" } }));
      }
      assert.equal(url.href, expectedProductUrl, "No field-specific URL or secondary product may be requested.");
      calls.product += 1;
      return new Response(failFirstProduct && calls.product === 1 ? "Temporarily unavailable" : body,
        { status: failFirstProduct && calls.product === 1 ? 503 : 200 });
    },
    executeRequest: denyTransport, executeBrowser: denyTransport, edgeExecutable, requestIntervalMs: 0,
    // Older callers can still supply this option; a missing field must never
    // use it to visit another marketplace.
    executeCrossMarketFetch: async () => { calls.crossMarket += 1; throw new Error("Unexpected cross-market lookup"); },
  });
  t.after(() => session.close());
  return { session, calls };
}

for (const importedUrl of [
  `${canonicalUrl}?th=1&psc=1`,
  `https://www.amazon.com.au/product-name/dp/${asin}/ref=detail?th=1`,
  `https://www.amazon.com.au/gp/product/${asin}?th=1`,
  `https://amazon.com.au/gp/aw/d/${asin}?th=1`,
]) {
  test(`the original validated product link reaches the product request: ${new URL(importedUrl).pathname}`, async t => {
    const { session, calls } = await mockedSession(t, { expectedProductUrl: importedUrl });
    const detail = await session.getProductDetail(asin, { productUrl: importedUrl });
    assert.equal(calls.product, 1);
    assert.equal(detail.asin, asin);
    assert.equal(detail.canonicalUrl, importedUrl);
  });
}

test('an imported URL cannot request a different ASIN or site before any network request', async t => {
  const { session, calls } = await mockedSession(t);
  for (const productUrl of [
    'https://www.amazon.com.au/dp/B000000002?th=1',
    `https://www.amazon.ca/dp/${asin}?th=1`,
    `https://www.amazon.com.au.evil.test/dp/${asin}`,
    `https://user@www.amazon.com.au/dp/${asin}`,
    `http://www.amazon.com.au/dp/${asin}`,
    `https://www.amazon.com.au/s?k=${asin}`, null,
  ]) await assert.rejects(session.getProductDetail(asin, { productUrl }), { code: 'INVALID_ASIN_URL' });
  assert.deepEqual(calls, { home: 0, region: 0, product: 0, crossMarket: 0 });
});

async function analyze(loader) {
  return analyzeAmazonDiscoveredAsins([{ asins: [asin], salesByAsin: { [asin]: { sales30: 100, rawText: "100+ bought in past month" } }, sourceStore: { storeIndex: 0 }, visit: { complete: true } }],
    { runId: "single-visit", marketplace: "AU", detailAsins: [asin] }, "2026-09-24T06:00:00.000Z", undefined,
    { detailLoader: loader });
}

test("one product HTML supplies every available field and its URL through durable snapshot storage", async t => {
  const { session, calls } = await mockedSession(t);
  const result = await analyze((requested, options) => session.getProductDetail(requested, options));
  assert.deepEqual(calls, { home: 1, region: 1, product: 1, crossMarket: 0 });
  assert.deepEqual(result.errors, []);
  const item = result.items[0];
  assert.equal(item.title, "Synthetic single-visit item");
  assert.equal(item.imageUrl, imageUrl);
  assert.equal(item.canonicalUrl, canonicalUrl);
  assert.equal(item.currentPrice, 9.99);
  assert.equal(item.productWeightKg, 0.06);
  assert.equal(item.fbaPackageWeightKg, 0.08);
  assert.equal(item.rating, 4.6);
  assert.equal(item.reviewCount, 1234);
  assert.equal(item.sales30, 100);
  assert.equal(item.sales30Evidence.kind, "lower_bound");
  assert.equal(item.sales30Evidence.value, 100);
  assert.equal(item.ratingEvidence.rawText, "4.6 out of 5 stars");
  assert.equal(item.reviewCountEvidence.rawText, "1,234 ratings");
  assert.equal(item.collectionQuality.fields.rating.evidence.value, 4.6);
  assert.equal(item.collectionQuality.status, "complete");
  assert.equal(item.priceEvidence.asin, asin);
  assert.equal(item.priceEvidence.currency, "AUD");

  const directory = path.join(temporaryRoot, "all-fields");
  const store = new PersistenceStore({ directory });
  await store.ready();
  await store.saveSnapshot({ runState: { id: "single-visit", marketplace: "AU", currency: "AUD", mode: "live" }, products: [] });
  await store.updateAmazonCollection("single-visit", () => ({ job: { revision: 1, status: "completed" }, items: { [asin]: item } }));
  const reloaded = new PersistenceStore({ directory });
  await reloaded.ready();
  const snapshot = await reloaded.getRunSnapshot("single-visit");
  const product = snapshot.products[0];
  assert.equal(product.canonicalUrl, canonicalUrl);
  assert.equal(product.imageUrl, imageUrl);
  assert.equal(product.currentPrice, 9.99);
  assert.equal(product.productWeight, 0.06);
  assert.equal(product.fbaWeight, 0.08);
  assert.equal(product.rating, 4.6);
  assert.equal(product.reviews, 1234);
  assert.equal(product.sales30, 100);
  assert.equal((await reloaded.getAmazonCollection("single-visit")).items[asin].canonicalUrl, canonicalUrl);
});

test("successful AU detail without price or weight is kept after one visit and never triggers a CA fallback", async t => {
  const { session, calls } = await mockedSession(t, { body: html(false) });
  const { items } = await analyze((requested, options) => session.getProductDetail(requested, options));
  assert.deepEqual(calls, { home: 1, region: 1, product: 1, crossMarket: 0 });
  assert.equal(items[0].detailStatus, "success");
  assert.equal(items[0].canonicalUrl, canonicalUrl);
  assert.equal(items[0].imageUrl, imageUrl);
  assert.equal(items[0].rating, 4.6);
  assert.equal(items[0].reviewCount, 1234);
  assert.equal(items[0].currentPrice, null);
  assert.equal(items[0].productWeightKg, null);
  assert.equal(items[0].collectionQuality.fields.price.reason, "delivery_region_unconfirmed");
  // 配送地区未确认的价格缺失保持可重试，供 CDP 重访补价。
  assert.deepEqual(items[0].collectionQuality.retryableFields, ["price", "weight"]);
  assert.equal(items[0].collectionQuality.fields.weight.reason, "product_information_incomplete");
});

test("a failed response may retry, then one successful HTML supplies all fields", async t => {
  const { session, calls } = await mockedSession(t, { failFirstProduct: true });
  const result = await session.getProductDetail(asin);
  assert.equal(calls.product, 2);
  assert.equal(calls.crossMarket, 0);
  assert.equal(result.currentPrice, 9.99);
  assert.equal(result.productWeightKg, 0.06);
  assert.equal(result.reviewCount, 1234);
});

test("saved product URLs must retain the selected marketplace while allowing page ASIN changes", async () => {
  const context = { marketplace: "AU", asin };
  assert.equal(normalizeAmazonProductUrl(`${canonicalUrl}?ref=detail#reviews`, context), `${canonicalUrl}?ref=detail`);
  const base = { id: `AU:${asin}`, asin, marketplace: "AU" };
  for (const rejected of [
    `https://www.amazon.ca/dp/${asin}`,
    `http://www.amazon.com.au/dp/${asin}`, `https://user:password@www.amazon.com.au/dp/${asin}`,
    `https://www.amazon.com.au.example.com/dp/${asin}`, `https://www.amazon.com.au:444/dp/${asin}`,
    "https://www.amazon.com.au/s?asin=B0FP55F3Q9", "/dp/B0FP55F3Q9", "?ref=wrong",
    "javascript:alert(1)", "", null,
  ]) {
    assert.equal(normalizeAmazonProductUrl(rejected, context), null, rejected);
    const { items } = await analyze(async () => ({ asin, title: "Synthetic item", canonicalUrl: rejected }));
    assert.equal(items[0].canonicalUrl, null, rejected);
    assert.equal(mergeAmazonCollectionProduct(base, { asin, marketplace: "AU", detailStatus: "success", canonicalUrl: rejected }).canonicalUrl, undefined);
  }
  const merged = mergeAmazonCollectionProduct(base, { asin, marketplace: "AU", detailStatus: "success", canonicalUrl });
  assert.equal(merged.canonicalUrl, canonicalUrl);
});


const streamAsins = ['B000000001', 'B000000002'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const streamDiscovery = [{ asins: streamAsins, sourceStore: { storeIndex: 0 }, salesByAsin: {}, visit: { complete: true } }];
const streamInput = { runId: 'stream-fixture', marketplace: 'AU', detailConcurrency: 2 };

test('each normalized detail is delivered and awaited before the remaining batch completes', async () => {
  const second = deferred(), firstStored = deferred();
  const saved = [];
  let finished = false;
  const work = analyzeAmazonDiscoveredAsins(streamDiscovery, streamInput, '2026-10-13T00:00:00Z', undefined, {
    detailLoader: async requested => {
      if (requested === streamAsins[1]) await second.promise;
      return { asin: requested, title: 'Streaming product', productWeightKg: 0.12, fieldSources: { productWeightKg: 'amazon_product_page' } };
    },
    onItem: async item => { saved.push(item); if (item.asin === streamAsins[0]) firstStored.resolve(); },
  }).then(result => { finished = true; return result; });
  await firstStored.promise;
  assert.equal(finished, false);
  assert.deepEqual(saved.map(item => item.asin), [streamAsins[0]]);
  assert.equal(saved[0].productWeightKg, 0.12);
  second.resolve();
  const result = await work;
  assert.deepEqual(result.items.map(item => item.asin), streamAsins);
  assert.deepEqual(saved.map(item => item.asin), streamAsins);
});

test('per-product persistence failure propagates instead of being rewritten as a detail failure', async () => {
  const diskError = new Error('isolated persistence failure');
  let callbacks = 0, visits = 0;
  await assert.rejects(analyzeAmazonDiscoveredAsins(streamDiscovery, { ...streamInput, detailConcurrency: 1 },
    '2026-10-13T00:00:00Z', undefined, {
      detailLoader: async requested => { visits++; return { asin: requested, title: 'Streamed item' }; },
      onItem: async () => { callbacks++; throw diskError; },
    }), error => error === diskError);
  assert.equal(callbacks, 1);
  assert.equal(visits, 1);
});

test('access pause from the first delivered item stops further detail scheduling', async () => {
  const controller = new AbortController();
  const pause = new Error('verified checkpoint needs user action');
  let visits = 0;
  await assert.rejects(analyzeAmazonDiscoveredAsins(streamDiscovery, { ...streamInput, detailConcurrency: 1 },
    '2026-10-13T00:00:00Z', controller.signal, {
      detailLoader: async () => { visits++; throw new AmazonStoreError('AMAZON_ACCESS_CHALLENGE', 'Robot Check'); },
      onItem: async item => { assert.equal(item.detailErrorCode, 'AMAZON_ACCESS_CHALLENGE'); controller.abort(pause); },
    }), error => error === pause);
  assert.equal(visits, 1);
});


test("the real collapsed CREST information table yields 20g through server mapping and durable profit calculation", async () => {
  const sourceAsin = "B08PSZMZRQ";
  const body = await readFile(new URL("./fixtures/amazon-b08pszmzrq-product-information.html", import.meta.url), "utf8");
  const parsed = parseAmazonProductPage(body, { marketplace: "AU", asin: sourceAsin });
  assert.equal(parsed.productWeightKg, 0.02);
  const info = parsed.productInformation;
  assert.equal(info.status, "complete");
  assert.equal(info.rowCount, 23);
  const result = await analyzeAmazonDiscoveredAsins([{ asins: [sourceAsin], sourceStore: { storeIndex: 0 }, visit: { complete: true } }],
    { runId: "crest-information", marketplace: "AU", detailAsins: [sourceAsin] }, "2026-10-13T08:00:00.000Z", undefined,
    { detailLoader: async () => ({ ...parsed, currentPrice: 6.99, canonicalUrl: `https://www.amazon.com.au/dp/${sourceAsin}`,
      priceEvidence: { asin: sourceAsin, currency: "AUD", source: "visible_main_price", selector: "#corePriceDisplay_desktop_feature_div .priceToPay", rawText: "$6.99", value: 6.99 } }) });
  const item = result.items[0];
  assert.deepEqual(item.productInformation, info);
  assert.equal(item.collectionQuality.fields.weight.status, "verified");
  const store = new PersistenceStore({ directory: path.join(temporaryRoot, "crest-information") });
  await store.ready();
  await store.saveSnapshot({ runState: { id: "crest-information", marketplace: "AU", currency: "AUD", mode: "live", analysisSourceMode: "amazon_only" }, products: [] });
  await store.updateAmazonCollection("crest-information", () => ({ job: { revision: 1, status: "completed" }, items: { [sourceAsin]: item } }));
  const saved = (await store.readRunFile("crest-information")).snapshot.products[0];
  assert.equal(saved.productWeight, 0.02);
  assert.equal(saved.profitCalculation.airFreight.actualWeightKg, 0.02);
  assert.equal(saved.fbaFee, 3.67);
  assert.deepEqual(saved.productInformation, info);
  assert.equal(saved.productInformation.sections.flatMap(section => section.rows).find(row => row.label === "Item Weight").value, "0.02 Kilograms");
});

const withoutInformation = () => html().replace(/<table id="productDetails_detailBullets_sections1">[\s\S]*?<\/table>/, '');

test('B09 user-provided source Item Weight survives parser, browser supplement, mapping and durable storage', async t => {
  const sourceAsin = 'B09NXS1BLL';
  const productUrl = `https://www.amazon.com.au/dp/${sourceAsin}?th=1`;
  const captured = await readFile(new URL('./fixtures/amazon-b09nxs1bll-mixed-identity.html', import.meta.url), 'utf8');
  const recorded = JSON.parse(await readFile(new URL('./fixtures/amazon-b09nxs1bll-disabled-specifications.json', import.meta.url), 'utf8'));
  const $ = load(captured);
  const originalRows = $('#item_details > table > tbody > tr');
  assert.equal(originalRows.eq(1).find('th').text().trim(), 'Age Range Description');
  assert.equal(originalRows.eq(1).find('td').text().trim(), 'Adult');
  // Only this third row is the source HTML pasted by the user on 2026-10-15.
  // The surrounding markup is previously captured HTML, not the user's full page.
  // This replay checks parsing/storage; it does not prove the browser obtained
  // the row, or explain why the live automated session did not receive it.
  const userSourceRow = await readFile(new URL('./fixtures/amazon-b09nxs1bll-user-source-weight-row.html', import.meta.url), 'utf8');
  originalRows.eq(1).after(userSourceRow);
  const withUserSourceRow = $.html();
  for (const [name, finalBody, expectedWeight] of [['captured-without-row', captured, null], ['user-provided-source-row', withUserSourceRow, .11]]) {
    const parsed = parseAmazonProductPage(finalBody, { marketplace: 'AU', asin: sourceAsin });
    assert.equal(parsed.productWeightKg, expectedWeight, name);
    assert.equal(parsed.amazonFirstAvailableDate, '2021-12-21', name);
    assert.equal(parsed.productInformation.weightStatus, expectedWeight === null ? 'unresolved' : 'found', name);
    if (expectedWeight !== null) {
      assert.equal(parsed.productWeightEvidence.rawText, '110 g');
      assert.match(parsed.productWeightEvidence.selector, /^#item_details/);
      assert.equal(parsed.productInformation.sections.find(section => section.heading === 'Item details').rows[2].label, 'Item Weight');
    }
    const { session, calls } = await mockedSession(t, { body: captured, edgeExecutable: 'C:/mock/msedge.exe', expectedProductUrl: productUrl });
    const browser = { navigations: [], inspections: 0, reads: 0 };
    t.mock.method(session, 'ensureEdgeCdpSession', async () => ({
      navigateUntilSettled: async url => { assert.equal(url, productUrl); browser.navigations.push(url); return { url }; },
      pageHtml: async () => ++browser.reads === 1 ? captured : finalBody,
      inspectProductInformation: async requested => {
        assert.equal(requested, sourceAsin);
        browser.inspections++;
        // Reuse the real failed inspection. A directly available Item Weight
        // remains valid even if another specification panel stays unavailable.
        return { ...structuredClone(recorded.productInformation.inspection), url: productUrl };
      },
    }));
    session.deliveryRegionReady.add('edge_cdp');
    const runId = `b09-source-row-replay-${name}`;
    const result = await analyzeAmazonDiscoveredAsins([{ asins: [sourceAsin], sourceStore: { storeIndex: 0 }, visit: { complete: true } }],
      { runId, marketplace: 'AU', detailAsins: [sourceAsin] }, '2026-10-15T03:06:11.423Z', undefined,
      { detailLoader: (requested, options) => session.getProductDetail(requested, { ...options, productUrl }) });
    assert.deepEqual(result.errors, [], name);
    assert.equal(calls.product, 1, name);
    assert.deepEqual(browser, { navigations: [productUrl], inspections: 1, reads: 2 }, name);
    const item = result.items[0];
    assert.equal(item.productWeightKg, expectedWeight, name);
    assert.equal(item.amazonFirstAvailableDate, '2021-12-21', name);
    assert.equal(item.productInformation.weightStatus, expectedWeight === null ? 'unresolved' : 'found', name);
    assert.equal(item.collectionQuality.fields.weight.status, expectedWeight === null ? 'missing' : 'verified', name);
    const store = new PersistenceStore({ directory: path.join(temporaryRoot, name) });
    await store.ready();
    await store.saveSnapshot({ runState: { id: runId, marketplace: 'AU', currency: 'AUD', mode: 'live', analysisSourceMode: 'amazon_only' }, products: [] });
    await store.updateAmazonCollection(runId, () => ({ job: { revision: 1, status: 'completed' }, items: { [sourceAsin]: item } }));
    const reloaded = new PersistenceStore({ directory: path.join(temporaryRoot, name) });
    await reloaded.ready();
    const saved = (await reloaded.getRunSnapshot(runId)).products[0];
    assert.equal(saved.productWeight, expectedWeight, name);
    assert.equal(saved.amazonFirstAvailableDate, '2021-12-21', name);
    assert.equal(saved.productInformation.weightStatus, expectedWeight === null ? 'unresolved' : 'found', name);
    if (expectedWeight !== null) assert.equal(saved.productWeightEvidence.rawText, '110 g');
    else assert.equal(saved.productWeightEvidence ?? null, null);
  }
});

const weightlessInformation = () => html(false) + '<table id="productDetails_detailBullets_sections1"><tr><th>Brand</th><td>Example</td></tr></table>';

async function browserSupplementSession(t, {
  body = withoutInformation(), initialBody = html(false), finalBody = html(), disabled = false,
  inspect = null, openError, expectedProductUrl = canonicalUrl,
} = {}) {
  const { session, calls } = await mockedSession(t, { body, edgeExecutable: disabled ? false : 'C:/mock/msedge.exe', expectedProductUrl });
  const browser = { opens: 0, navigations: [], inspections: 0, reads: 0 };
  const cdp = {
    navigateUntilSettled: async (url, signal) => {
      assert.equal(signal?.aborted || false, false);
      assert.equal(url, expectedProductUrl);
      browser.navigations.push(url);
      return { url };
    },
    pageHtml: async () => { browser.reads += 1; return browser.reads === 1 ? initialBody : finalBody; },
    inspectProductInformation: async (requested, options) => {
      assert.equal(requested, asin);
      browser.inspections += 1;
      if (inspect) return inspect(requested, options);
      const parsed = parseAmazonProductPage(finalBody, { marketplace: "AU", asin });
      const sections = parsed.productInformation.sections.map(section => ({ selector: section.selector, rowCount: section.rows.length, status: "complete" }));
      return { version: 3, status: "complete", stable: true, asin, url: expectedProductUrl,
        rowCount: parsed.productInformation.rowCount, sections, parsedSections: sections.map(({selector, rowCount}) => ({selector, rowCount})) };
    },
  };
  t.mock.method(session, 'ensureEdgeCdpSession', async () => {
    browser.opens += 1;
    if (openError) throw openError;
    return cdp;
  });
  session.deliveryRegionReady.add('edge_cdp');
  return { session, calls, browser, cdp };
}

test('bare-domain imported links retain their trusted origin during browser information inspection', async t => {
  const productUrl = `https://amazon.com.au/gp/aw/d/${asin}?th=1`;
  let inspectedOrigin;
  const { session, browser } = await browserSupplementSession(t, {
    expectedProductUrl: productUrl,
    inspect: async (requested, options) => {
      inspectedOrigin = options.expectedOrigin;
      return options.expectedOrigin === new URL(productUrl).origin
        ? { version: 3, status: 'complete', stable: true, asin, url: productUrl, rowCount: 2, sections: [] }
        : { status: 'blocked', reason: 'marketplace_changed', url: productUrl };
    },
  });
  const detail = await session.getProductDetail(asin, { productUrl });
  assert.equal(inspectedOrigin, 'https://amazon.com.au');
  assert.equal(detail.productWeightKg, 0.06);
  assert.deepEqual(browser.navigations, [productUrl]);
});

test('missing weight with incomplete information uses one same-ASIN browser visit and one bounded DOM inspection', async t => {
  const { session, calls, browser } = await browserSupplementSession(t, { finalBody: html().replace(/<div id="corePriceDisplay_desktop_feature_div">.*?<\/div>/, '') });
  const result = await session.getProductDetail(asin);
  assert.equal(calls.product, 1);
  assert.deepEqual(browser, { opens: 1, navigations: [canonicalUrl], inspections: 1, reads: 2 });
  assert.equal(result.productWeightKg, 0.06);
  assert.equal(result.productInformation.status, 'complete');
  assert.equal(result.currentPrice, 9.99, 'the successful fetch price and its evidence survive a weight-only browser result');
  assert.equal(result.priceEvidence.rawText, '$9.99');
  assert.equal(result.priceEvidence.asin, asin);
  assert.equal(result.canonicalUrl, canonicalUrl);
});

test('cart-price and incomplete-weight recovery share the same single browser navigation', async t => {
  const body = html(false) + '<div id="priceNotAvailable_feature_div">See price in cart</div>';
  const { session, calls, browser } = await browserSupplementSession(t, { body });
  const result = await session.getProductDetail(asin);
  assert.equal(calls.product, 1);
  assert.equal(browser.navigations.length, 1);
  assert.equal(browser.inspections, 1);
  assert.equal(result.currentPrice, 9.99);
  assert.equal(result.productWeightKg, 0.06);
});

test('structural weightless HTML gets one browser supplement; explicitly disabled Edge stays unresolved', async t => {
  for (const options of [{ body: weightlessInformation() }, { disabled: true }]) {
    const { session, calls, browser } = await browserSupplementSession(t, options);
    const result = await session.getProductDetail(asin);
    assert.equal(calls.product, 1);
    assert.equal(browser.opens, options.disabled ? 0 : 1);
    assert.equal(browser.navigations.length, options.disabled ? 0 : 1);
    assert.equal(result.productInformation.weightStatus, options.disabled ? 'unresolved' : 'found');
  }
});

test('a structurally complete first browser DOM still needs panel inspection before absence', async t => {
  const { session, browser } = await browserSupplementSession(t, { initialBody: weightlessInformation(), finalBody: weightlessInformation() });
  const result = await session.getProductDetail(asin);
  assert.deepEqual(browser, { opens: 1, navigations: [canonicalUrl], inspections: 1, reads: 2 });
  assert.equal(result.productInformation.status, 'complete');
  assert.equal(result.productInformation.weightStatus, 'not_provided');
  assert.equal(result.amazonFirstAvailableDateStatus, 'not_provided');
});

test('an unfinished DOM inspection cannot certify that weight is absent even when the last HTML has rows', async t => {
  const { session, browser } = await browserSupplementSession(t, {
    finalBody: weightlessInformation(), inspect: async () => ({ asin, url: canonicalUrl, status: 'incomplete', reason: 'inspection_timeout' }),
  });
  const result = await session.getProductDetail(asin);
  assert.equal(browser.navigations.length, 1);
  assert.equal(browser.inspections, 1);
  assert.equal(result.productInformation.status, 'incomplete');
  assert.equal(result.productInformation.reason, 'inspection_timeout');
  assert.equal(result.productInformation.weightStatus, 'unresolved');
  assert.equal(result.currentPrice, 9.99);
});

test('an unavailable browser preserves the original successful fields and incomplete information', async t => {
  const { session, calls, browser } = await browserSupplementSession(t, {
    openError: new AmazonStoreError('AMAZON_EDGE_UNAVAILABLE', 'Synthetic missing Edge'),
  });
  const result = await session.getProductDetail(asin);
  assert.equal(calls.product, 1);
  assert.equal(browser.opens, 1);
  assert.equal(browser.navigations.length, 0);
  assert.equal(result.currentPrice, 9.99);
  assert.equal(result.title, 'Synthetic single-visit item');
  assert.equal(result.productInformation.status, 'incomplete');
  assert.equal(result.productInformation.weightStatus, 'unresolved');
  assert.equal(result.productInformation.inspection.errorCode, 'AMAZON_EDGE_UNAVAILABLE');
  assert.equal(result.productInformation.inspection.errorMessage, 'Synthetic missing Edge');
  assert.equal(result.productInformation.inspection.reason, 'browser_inspection_failed');
  assert.equal(result.productInformation.inspection.stable, false);
});

test('optional browser inspection timeout preserves known weight and date while recording the exact failure through storage', async t => {
  const original = withAvailableDate(html(), '17 June 2020')
    .replace('<span class="a-offscreen">$9.99</span>', '') + '<div id="priceNotAvailable_feature_div">See price in cart</div>';
  const { session, browser } = await browserSupplementSession(t, { body: original,
    inspect: async () => { throw new AmazonStoreError('EDGE_CDP_TIMEOUT', 'CDP command Runtime.evaluate timed out.'); },
  });
  const { items } = await analyze((requested, options) => session.getProductDetail(requested, options));
  const item = items[0];
  assert.equal(browser.navigations.length, 1);
  assert.equal(browser.inspections, 1);
  assert.equal(item.productWeightKg, 0.06);
  assert.equal(item.productWeightEvidence.rawText, '60 g');
  assert.equal(item.amazonFirstAvailableDate, '2020-06-17');
  assert.equal(item.amazonFirstAvailableDateStatus, 'found');
  assert.equal(item.productInformation.inspection.reason, 'browser_inspection_failed');
  assert.equal(item.productInformation.inspection.errorCode, 'EDGE_CDP_TIMEOUT');
  assert.equal(item.productInformation.inspection.errorMessage, 'CDP command Runtime.evaluate timed out.');
  assert.equal(item.productInformation.inspection.asin, asin);
  assert.equal(item.productInformation.inspection.status, 'incomplete');
  const store = new PersistenceStore({ directory: path.join(temporaryRoot, 'browser-failure-reason') });
  await store.ready();
  await store.saveSnapshot({ runState: { id: 'browser-failure', marketplace: 'AU', currency: 'AUD', mode: 'live' }, products: [] });
  await store.updateAmazonCollection('browser-failure', () => ({ job: { revision: 1, status: 'completed' }, items: { [asin]: item } }));
  const saved = await store.getRunSnapshot('browser-failure');
  assert.deepEqual(saved.products[0].productInformation.inspection, item.productInformation.inspection);
  assert.equal(saved.products[0].productWeight, 0.06);
});

test('verification and cross-market inspection results cannot be swallowed as optional browser failures', async t => {
  for (const [state, code] of [
    [{ status: 'blocked', reason: 'access_challenge' }, 'AMAZON_ACCESS_CHALLENGE'],
    [{ status: 'blocked', reason: 'product_page_context_mismatch' }, 'AMAZON_PRODUCT_REDIRECT_REJECTED'],
    [{ status: 'complete', url: `https://www.amazon.ca/dp/${asin}` }, 'AMAZON_PRODUCT_REDIRECT_REJECTED'],
  ]) {
    const { session, calls, browser } = await browserSupplementSession(t, { inspect: async () => state });
    await assert.rejects(session.getProductDetail(asin), { code });
    assert.equal(calls.product, 1);
    assert.equal(browser.navigations.length, 1);
    assert.equal(browser.reads, 1);
  }
});

test('access verification in the reread HTML still stops the item', async t => {
  for (const [finalBody, code] of [
    ['<html><title>Robot Check</title><form action="/errors/validateCaptcha"><input id="captchacharacters"></form></html>', 'AMAZON_ACCESS_CHALLENGE'],
  ]) {
    const { session, calls, browser } = await browserSupplementSession(t, { finalBody, inspect: async () => ({version: 3, asin, stable: true, status: "complete", url: canonicalUrl}) });
    await assert.rejects(session.getProductDetail(asin), { code });
    assert.equal(calls.product, 1);
    assert.equal(browser.reads, 2);
    assert.equal(browser.navigations.length, 1);
  }
});

test('manual abort during inspection is propagated without a second DOM read or retry visit', async t => {
  const controller = new AbortController();
  const reason = new Error('User paused during product-information inspection');
  const { session, calls, browser } = await browserSupplementSession(t, {
    inspect: async (_asin, options) => {
      assert.equal(options.signal, controller.signal);
      controller.abort(reason);
      throw reason;
    },
  });
  await assert.rejects(session.getProductDetail(asin, { signal: controller.signal }), error => error === reason);
  assert.equal(calls.product, 1);
  assert.equal(browser.navigations.length, 1);
  assert.equal(browser.reads, 1);
  assert.equal(browser.inspections, 1);
});

test('the shared browser tab stays locked through inspection and its matching final DOM read', async t => {
  const entered = deferred(), release = deferred();
  const { session, browser } = await browserSupplementSession(t, {
    inspect: async () => { entered.resolve(); await release.promise; return { status: 'complete', asin, url: canonicalUrl }; },
  });
  const first = session.fetchProductDetailWithEdgeCdp(canonicalUrl, asin);
  await entered.promise;
  const second = session.fetchProductDetailWithEdgeCdp(canonicalUrl, asin);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(browser.navigations.length, 1);
  assert.equal(browser.reads, 1);
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.productWeightKg === 0.06));
  assert.equal(browser.navigations.length, 2);
  assert.equal(browser.inspections, 2);
  assert.equal(browser.reads, 4);
});

const withAvailableDate = (body, value) => body.replace('</body>', `<table id="productDetails_techSpec_section_1"><tr><th>Date First Available</th><td>${value}</td></tr></table></body>`);

test('date evidence flows through a successful fetch while disabled Edge leaves absence unresolved', async t => {
  for (const [body, expected, status] of [
    [withAvailableDate(html(), '17 June 2020'), '2020-06-17', 'found'],
    [html(), null, 'unresolved'],
    [withAvailableDate(html(), '03/04/2020'), null, 'unresolved'],
  ]) {
    const { session, calls, browser } = await browserSupplementSession(t, { body, disabled: true });
    const result = await session.getProductDetail(asin);
    assert.equal(result.amazonFirstAvailableDate, expected);
    assert.equal(result.amazonFirstAvailableDateStatus, status);
    assert.equal(calls.product, 1);
    assert.equal(calls.crossMarket, 0);
    assert.equal(browser.opens, 0);
    assert.equal(browser.navigations.length, 0);
    if (status === 'found') {
      assert.equal(result.amazonFirstAvailableDateEvidence.asin, asin);
      assert.equal(result.amazonFirstAvailableDateEvidence.marketplace, 'AU');
      assert.equal(result.amazonFirstAvailableDateEvidence.rawText, '17 June 2020');
      assert.equal(result.fieldSources.amazonFirstAvailableDate, 'amazon_product_information');
    }
  }
});

test('a browser weight supplement preserves the first fetch date and evidence when it omits that row', async t => {
  const body = withAvailableDate(withoutInformation(), '17 June 2020').replace('</body>', '<div id="prodDetails"></div></body>');
  const { session, calls, browser } = await browserSupplementSession(t, { body });
  const result = await session.getProductDetail(asin);
  assert.equal(calls.product, 1);
  assert.equal(browser.navigations.length, 1);
  assert.equal(result.productWeightKg, 0.06);
  assert.equal(result.amazonFirstAvailableDate, '2020-06-17');
  assert.equal(result.amazonFirstAvailableDateStatus, 'found');
  assert.equal(result.amazonFirstAvailableDateEvidence.rawText, '17 June 2020');
  assert.equal(result.fieldSources.amazonFirstAvailableDate, 'amazon_product_information');
});

test('conflicting first-available dates between fetch and browser retain both sources and stay unresolved', async t => {
  const body = withAvailableDate(withoutInformation(), '17 June 2020').replace('</body>', '<div id="prodDetails"></div></body>');
  const { session, calls, browser } = await browserSupplementSession(t, { body, finalBody: withAvailableDate(html(), '18 June 2020') });
  const result = await session.getProductDetail(asin);
  assert.equal(calls.product, 1);
  assert.equal(browser.navigations.length, 1);
  assert.equal(result.productWeightKg, 0.06);
  assert.equal(result.amazonFirstAvailableDate, null);
  assert.equal(result.amazonFirstAvailableDateStatus, 'unresolved');
  assert.deepEqual(result.amazonFirstAvailableDateEvidence.candidates.map(row => row.rawText), ['17 June 2020', '18 June 2020']);
  assert.equal(result.fieldSources.amazonFirstAvailableDate, undefined);
});

test('unfinished browser information inspection cannot certify date absence but retains an actual date row', async t => {
  for (const [finalBody, expected, status] of [[html(), null, 'unresolved'], [withAvailableDate(html(), '17 June 2020'), '2020-06-17', 'found']]) {
    const { session, browser } = await browserSupplementSession(t, {
      finalBody, inspect: async () => ({ status: 'incomplete', reason: 'unparsed_rows', asin, url: canonicalUrl }),
    });
    const result = await session.getProductDetail(asin);
    assert.equal(browser.navigations.length, 1);
    assert.equal(result.productInformation.status, 'incomplete');
    assert.equal(result.amazonFirstAvailableDate, expected);
    assert.equal(result.amazonFirstAvailableDateStatus, status);
    assert.equal(result.fieldSources.amazonFirstAvailableDate, status === 'found' ? 'amazon_product_information' : undefined);
  }
});

test('date evidence survives server normalization and durable product projection independently of manual inputs and SellerSprite dates', async t => {
  const manual = {
    manualAmazonFields: { currentPrice: true }, currentPrice: 23.45, currentPriceStatus: 'manual',
    manualSalePrice: true, salePrice: 24.95, manualWeight: true,
    productWeight: 0.21, fbaWeight: 0.25, billingWeight: 0.21,
    manualPurchaseCost: true, purchaseCost: 8.5, purchaseUnitCostCny: 8.5,
    suppliers: [{ unitPriceCny: 8.5, source: 'saved_manual_quote' }], listingAvailableAt: '2018-02-03',
  };
  for (const [name, body, expected, status] of [
    ['found', withAvailableDate(html(), '17 June 2020'), '2020-06-17', 'found'],
    ['absent', html(), null, 'unresolved'],
    ['invalid', withAvailableDate(html(), '03/04/2020'), null, 'unresolved'],
  ]) {
    const { session, calls } = await mockedSession(t, { body });
    const { items } = await analyze((requested, options) => session.getProductDetail(requested, options));
    const item = items[0];
    assert.equal(item.amazonFirstAvailableDate, expected);
    assert.equal(item.amazonFirstAvailableDateStatus, status);
    assert.equal(calls.product, 1);
    assert.equal(item.collectionQuality.status, 'complete', 'Optional date absence or ambiguity must not make collection incomplete.');
    assert.equal(item.detailParserVersion, 13);
    const directory = path.join(temporaryRoot, `listing-date-${name}`);
    const store = new PersistenceStore({ directory });
    await store.ready();
    await store.saveSnapshot({ runState: { id: name, marketplace: 'AU', currency: 'AUD', mode: 'live', analysisSourceMode: 'amazon_only' },
      products: [{ id: `AU:${asin}`, asin, sourceAsin: asin, marketplace: 'AU', currency: 'AUD', ...structuredClone(manual),
        fieldSources: { currentPrice: 'manual', productWeightKg: 'manual', amazonFirstAvailableDate: 'obsolete_date_source' } }] });
    await store.updateAmazonCollection(name, () => ({ job: { revision: 1, status: 'paused', enabled: false, causeCode: 'USER_PAUSED' }, items: { [asin]: item } }));
    const reloaded = new PersistenceStore({ directory });
    await reloaded.ready();
    const durable = await reloaded.readRunFile(name);
    const product = durable.snapshot.products[0];
    assert.equal(product.amazonFirstAvailableDate, expected);
    assert.equal(product.amazonFirstAvailableDateStatus, status);
    assert.deepEqual(product.amazonFirstAvailableDateEvidence, item.amazonFirstAvailableDateEvidence);
    assert.deepEqual(durable.amazonCollection.items[asin].amazonFirstAvailableDateEvidence, item.amazonFirstAvailableDateEvidence);
    assert.equal(product.fieldSources.amazonFirstAvailableDate, status === 'found' ? 'amazon_product_information' : undefined);
    for (const [key, value] of Object.entries(manual)) assert.deepEqual(product[key], value, `${name}: ${key}`);
    assert.equal(durable.amazonCollection.job.status, 'paused');
    assert.equal(durable.amazonCollection.job.enabled, false);
  }
});


test('a known weight still gets one bounded date inspection and keeps original same-ASIN weight evidence', async t => {
  const { session, calls, browser } = await browserSupplementSession(t, { body: html(), initialBody: html(),
    finalBody: withAvailableDate(html().replace('<tr><th>Item Weight</th><td>60 g</td></tr>', ''), '17 June 2020') });
  const result = await session.getProductDetail(asin);
  assert.equal(calls.product, 1);
  assert.equal(browser.navigations.length, 1);
  assert.equal(browser.inspections, 1);
  assert.equal(result.amazonFirstAvailableDate, '2020-06-17');
  assert.equal(result.productWeightKg, 0.06);
  assert.equal(result.productWeightEvidence.rawText, '60 g');
});

test('latest browser Item Weight supersedes HTTP readings and keeps them as diagnostics', async t => {
  const { session, browser } = await browserSupplementSession(t, { body: html(), finalBody: html().replace('60 g', '140 g') });
  const result = await session.getProductDetail(asin);
  assert.equal(browser.navigations.length, 1);
  assert.equal(result.productWeightKg, .14);
  assert.equal(result.productWeightEvidence.rawText, '140 g');
  assert.equal(result.productInformation.weightConflicts, undefined);
  assert.ok(result.productInformation.weightSelection.alternatives.some(reading => reading.rawText === '60 g'));
});

test('170g versus its rounded 0.37lb display survives HTTP and expanded-browser reconciliation', async t => {
  const pounds = html().replace('60 g', '0.37 Pounds');
  const grams = html().replace('60 g', '170 Grams');
  const { session, browser } = await browserSupplementSession(t, { body: pounds, initialBody: pounds, finalBody: grams });
  const result = await session.getProductDetail(asin);
  assert.equal(browser.navigations.length, 1);
  assert.equal(browser.inspections, 1);
  assert.equal(result.productWeightKg, 0.17);
  assert.equal(result.productWeightEvidence.rawText, '170 Grams');
  assert.equal(result.productWeightEvidence.asin, asin);
  assert.equal(result.fieldSources.productWeightKg, 'amazon_product_page');
  assert.equal(result.productInformation.weightStatus, 'found');
  assert.equal(result.productInformation.reason, null);
});

test('fetch and browser supplement retain Voyager and bullet data despite ASIN differences', async t => {
  const captured = await readFile(new URL('./fixtures/amazon-b09nxs1bll-mixed-identity.html', import.meta.url), 'utf8');
  const body = captured.replaceAll('B09NXS1BLL', asin);
  const { session, browser } = await browserSupplementSession(t, { body, initialBody: body, finalBody: body });
  const result = await session.getProductDetail(asin);
  assert.equal(browser.navigations.length, 1);
  assert.equal(browser.inspections, 1);
  assert.equal(result.asin, asin);
  assert.equal(result.identity.brand, 'PEXEW');
  assert.equal(result.productInformation.status, 'complete');
  assert.equal(result.productInformation.rowCount, 17);
  assert.equal(result.productInformation.weightStatus, 'not_provided');
  assert.equal(result.amazonFirstAvailableDateStatus, 'found');
  assert.equal(result.amazonFirstAvailableDate, '2021-12-21');
  assert.equal(result.productInformation.discardedSections, undefined);
  assert.ok(result.productInformation.identityDiagnostics.specificationAsins.includes('B09QHCKV68'));
});

test('conflicted fetch dates cannot become verified just because the browser returns only one of them', async t => {
  const body = withAvailableDate(withAvailableDate(withoutInformation(), '17 June 2020'), '18 June 2020');
  const { session, browser } = await browserSupplementSession(t, { body, finalBody: withAvailableDate(html(), '17 June 2020') });
  const result = await session.getProductDetail(asin);
  assert.equal(browser.navigations.length, 1);
  assert.equal(result.amazonFirstAvailableDateStatus, 'unresolved');
  assert.equal(result.amazonFirstAvailableDate, null);
  assert.ok(result.amazonFirstAvailableDateEvidence.candidates.some(row => row.rawText === '18 June 2020'));
});


test('reread page ASIN differences keep source task identity and collected fields', async t => {
  const {session} = await browserSupplementSession(t, {finalBody:html().replaceAll(asin,'B000000009')});
  const result=await session.getProductDetail(asin);
  assert.equal(result.asin,asin);
  assert.equal(result.productWeightKg,.06);
  assert.equal(result.rating,4.6);
  assert.equal(result.reviewCount,1234);
  assert.equal(result.productInformation.identityDiagnostics.pageAsin,'B000000009');
});


test('ordinary browser loading timeout preserves HTTP evidence instead of becoming an access challenge', async t => {
  const { session } = await mockedSession(t, { edgeExecutable: 'mock-edge' });
  session.fetchProductDetailWithEdgeCdp = async () => { throw new AmazonStoreError('EDGE_CDP_NAVIGATION_TIMEOUT', 'Page loading timed out; no verification confirmed.'); };
  const result = await session.getProductDetail(asin);
  assert.equal(result.currentPrice, 9.99);
  assert.equal(result.productWeightKg, .06);
  assert.equal(result.productInformation.inspection.errorCode, 'EDGE_CDP_NAVIGATION_TIMEOUT');
  assert.equal(result.productInformation.inspection.status, 'incomplete');
});
