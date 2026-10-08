import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createAmazonStoreSession, normalizeAmazonProductUrl } from "../lib/amazon-store-client.mjs";
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

async function mockedSession(t, { body = html(), failFirstProduct = false } = {}) {
  const calls = { home: 0, region: 0, product: 0, crossMarket: 0 };
  const denyTransport = async () => { throw new Error("Unexpected external transport"); };
  const session = await createAmazonStoreSession("AU", {
    executeFetch: async (value, options) => {
      const url = new URL(value);
      assert.equal(url.origin, "https://www.amazon.com.au");
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
      assert.equal(url.href, canonicalUrl, "No field-specific URL or secondary product may be requested.");
      calls.product += 1;
      return new Response(failFirstProduct && calls.product === 1 ? "Temporarily unavailable" : body,
        { status: failFirstProduct && calls.product === 1 ? 503 : 200 });
    },
    executeRequest: denyTransport, executeBrowser: denyTransport, edgeExecutable: false, requestIntervalMs: 0,
    // Older callers can still supply this option; a missing field must never
    // use it to visit another marketplace.
    executeCrossMarketFetch: async () => { calls.crossMarket += 1; throw new Error("Unexpected cross-market lookup"); },
  });
  t.after(() => session.close());
  return { session, calls };
}

async function analyze(loader) {
  return analyzeAmazonDiscoveredAsins([{ asins: [asin], sourceStore: { storeIndex: 0 }, visit: { complete: true } }],
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
  assert.deepEqual(items[0].collectionQuality.retryableFields, ["price"]);
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

test("saved product URLs must retain the selected marketplace and ASIN", async () => {
  const context = { marketplace: "AU", asin };
  assert.equal(normalizeAmazonProductUrl(`${canonicalUrl}?ref=detail#reviews`, context), `${canonicalUrl}?ref=detail`);
  const base = { id: `AU:${asin}`, asin, marketplace: "AU" };
  for (const rejected of [
    `https://www.amazon.ca/dp/${asin}`, "https://www.amazon.com.au/dp/B012345678",
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
