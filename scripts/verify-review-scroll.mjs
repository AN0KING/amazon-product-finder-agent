// Offline browser regression: generated demo products and no business requests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.SCOUT_TEST_PLAYWRIGHT || "D:/deliverables/1688-procurement-assistant-2.3.0/node_modules/playwright-core/index.mjs"));
const source = await readFile(process.env.SCOUT_TEST_APP_SOURCE || path.join(root, "app.js"), "utf8");
assert.ok(source.includes('document.addEventListener("DOMContentLoaded", init);'));
const testSource = source.replace('document.addEventListener("DOMContentLoaded", init);', `
  document.addEventListener("DOMContentLoaded", () => {
    activeMarket = MARKET_CONFIGS.AU;
    runState = { ...createIdleRunState(), id: "synthetic-scroll-review", mode: "mock", marketplace: "AU" };
    activeRunCriteria = { monthlySalesBand: "all" };
    renderMarketUi(); applyStoredCriteriaToInputs({}, false);
    const seed = hydrateFallbackProducts().find(item => Number.isFinite(item.margin) && item.margin > 0);
    if (!seed) throw new Error("No calculable synthetic product");
    products = Array.from({ length: 120 }, (_, i) => ({ ...structuredClone(seed),
      id: "AU:B0" + String(i).padStart(8, "0"), asin: "B0" + String(i).padStart(8, "0"),
      name: "Synthetic review product " + i, imageUrl: null, reviewStatus: "pending"
    }));
    persistCurrentRun = async () => {};
    bindResults(); bindDrawer(); bindManualCostDialog(); showView("results");
    window.reviewTest = {
      openDrawer, closeDrawer,
      refresh: () => renderResults(),
      status: id => products.find(item => item.id === id)?.reviewStatus,
      remove: id => { products = products.filter(item => item.id !== id); renderResults(); },
      active: () => activeProductId
    };
  });
`);
const browser = await chromium.launch({ headless: true, executablePath: process.env.SCOUT_TEST_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://review.test") return route.abort();
    if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: testSource });
    const assets = {
      "/": ["index.html", "text/html"], "/styles.css": ["styles.css", "text/css"],
      "/lib/profit-model.mjs": ["lib/profit-model.mjs", "text/javascript"],
      "/lib/title-piece-count.mjs": ["lib/title-piece-count.mjs", "text/javascript"],
      "/lib/analysis-handoff.mjs": ["lib/analysis-handoff.mjs", "text/javascript"],
      "/lib/analysis-coverage.mjs": ["lib/analysis-coverage.mjs", "text/javascript"],
    };
    const asset = assets[url.pathname];
    if (asset) return route.fulfill({ contentType: asset[1], body: await readFile(path.join(root, asset[0])) });
    if (url.pathname === "/vendor/lucide.min.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    return route.abort();
  });
  await page.goto("http://review.test/");
  await page.waitForFunction(() => !!window.reviewTest);
  const scroll = () => page.locator(".view-stack").evaluate(el => el.scrollTop);
  const row = i => page.locator("#productTableBody tr[data-product-id]").nth(i);
  const result = [];
  for (const [i, action, status] of [[35, "approveProductButton", "approved"], [36, "approveProductButton", "approved"], [37, "rejectProductButton", "rejected"]]) {
    await row(i).scrollIntoViewIfNeeded();
    await row(i).locator(".row-open-button").click();
    const before = await scroll();
    assert.ok(before > 1000);
    const id = await page.evaluate(() => window.reviewTest.active());
    await page.locator("#" + action).click();
    await page.locator("#drawerBackdrop").waitFor({ state: "hidden" });
    const after = await scroll();
    assert.ok(Math.abs(after - before) <= 1, action + " jumped from " + before + " to " + after);
    assert.equal(await page.evaluate(id => window.reviewTest.status(id), id), status);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.productId), id);
    result.push({ action, before, after });
  }
  await row(40).scrollIntoViewIfNeeded();
  await row(40).locator(".row-open-button").click();
  const beforeRemoval = await scroll();
  await page.evaluate(() => { window.reviewTest.remove(window.reviewTest.active()); window.reviewTest.closeDrawer(); });
  await page.locator("#drawerBackdrop").waitFor({ state: "hidden" });
  assert.ok(Math.abs((await scroll()) - beforeRemoval) <= 1);
  assert.equal(await page.evaluate(() => document.activeElement.matches("#productTableBody tr")), true);
  await row(41).scrollIntoViewIfNeeded();
  await row(41).locator(".row-open-button").click();
  const beforeManual = await scroll();
  const manualId = await page.evaluate(() => window.reviewTest.active());
  await page.locator("#openManualCostButton").click();
  await page.locator("#manualCostApproveButton").click();
  await page.locator("#manualCostDialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(id => window.reviewTest.status(id), manualId), "approved");
  await page.locator("#closeDrawerButton").click();
  await page.locator("#drawerBackdrop").waitFor({ state: "hidden" });
  assert.ok(Math.abs((await scroll()) - beforeManual) <= 1, "Manual approval changed list position");

  await row(42).scrollIntoViewIfNeeded();
  await row(42).locator(".row-open-button").click();
  const beforeFilterRemoval = await scroll();
  const filteredId = await page.evaluate(() => window.reviewTest.active());
  await page.evaluate(() => { document.getElementById("resultMinMargin").value = "0"; });
  await page.locator('[data-detail-tab="profit"]').click();
  await page.locator("#editPurchaseCost").fill("999");
  await page.locator("#approveProductButton").click();
  await page.locator("#drawerBackdrop").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(id => window.reviewTest.status(id), filteredId), "approved");
  assert.equal(await page.locator(`tr[data-product-id="${filteredId}"]`).count(), 0);
  assert.ok(Math.abs((await scroll()) - beforeFilterRemoval) <= 1, "Profit filter removal changed list position");
  assert.equal(await page.evaluate(() => document.activeElement.matches("#productTableBody tr")), true);

  const beforeRefresh = await scroll();
  await page.evaluate(() => window.reviewTest.refresh());
  await page.waitForTimeout(250);
  assert.ok(Math.abs((await scroll()) - beforeRefresh) <= 1, "Background refresh changed list position");
  const nextId = await row(42).getAttribute("data-product-id");
  await page.evaluate(id => { window.reviewTest.openDrawer(id); window.reviewTest.closeDrawer(); window.reviewTest.openDrawer(id); }, nextId);
  await page.waitForTimeout(250);
  assert.equal(await page.locator("#drawerBackdrop").isVisible(), true);
  assert.equal(await page.evaluate(() => window.reviewTest.active()), nextId);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, reviews: result, removedRowFallback: true, manualApproval: true, profitFilterRemoval: true, backgroundRefresh: true, rapidReopen: true }, null, 2));
} finally {
  await browser.close();
}
