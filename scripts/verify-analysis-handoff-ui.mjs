// Offline UI acceptance: synthetic data, mocked local writes, no platform calls.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createAnalysisHandoffPackage } from "../lib/analysis-handoff.mjs";
import { syntheticAnalysisInput } from "../integration/analysis/synthetic-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.SCOUT_TEST_PLAYWRIGHT || "D:/deliverables/1688-procurement-assistant-2.3.0/node_modules/playwright-core/index.mjs"));
const source = await readFile(path.join(root, "app.js"), "utf8");
const fixture = syntheticAnalysisInput();
// This harness proves actual approval clicks; shared export fixtures may already be reviewed.
fixture.products.forEach(product => { product.reviewStatus = "pending"; });
const testSource = source.replace('document.addEventListener("DOMContentLoaded", init);', `
  document.addEventListener("DOMContentLoaded", () => {
    const fixture = ${JSON.stringify(fixture)};
    activeMarket = MARKET_CONFIGS.AU;
    runState = { ...createIdleRunState(), ...fixture.runState, mode: "live", startedAt: fixture.createdAt };
    activeRunCriteria = fixture.criteria.amazon;
    storeList = { audit: { marketplace: "AU" }, stores: [{ sellerId: "SYNTHETIC_SELLER_A", sellerName: "Synthetic AU Store", marketplace: "AU", rowNumbers: [2], criteria: {}, criteriaSource: { rows: [{ rowNumber: 2, rawCriteria: { minRating: "4" } }] } }], rejectedRows: [{ rowNumber: 9, code: "MARKETPLACE_MISMATCH", marketplace: "US" }] };
    const seed = hydrateFallbackProducts().find(item => Number.isFinite(item.margin));
    products = fixture.products.map(item => ({ ...structuredClone(seed), ...item, name: item.englishName, dataMode: "live", imageUrl: null }));
    renderMarketUi(); applyStoredCriteriaToInputs(activeRunCriteria, false);
    byId("resultMinMargin").value = "0";
    products.forEach(updateProductComputed);
    bindResults(); bindDrawer(); showView("results");
    window.handoffTest = {
      prepared: buildAnalysisHandoffInput,
      products: () => structuredClone(products),
      active: () => activeProductId,
      exportNow: exportAnalysisHandoff,
      mutateBlocked: () => { const p = products[0]; apply1688SearchResult(p, {}); refreshProductWeightState(p); applyAutomaticFba(p); refreshSupplierTarget(p); updateProductComputed(p); },
      changeMinMargin: value => { byId("resultMinMargin").value = String(value); renderResults(); },
      blockStore: () => { storeList.stores[0].importBlocked = true; renderResults(); },
    };
  });
`);
assert.notEqual(testSource, source);
const browser = await chromium.launch({ headless: true, executablePath: process.env.SCOUT_TEST_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors = [], packages = [], saves = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "http://handoff.test") return route.abort();
    if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: testSource });
    const assets = { "/": ["index.html", "text/html"], "/styles.css": ["styles.css", "text/css"], "/lib/profit-model.mjs": ["lib/profit-model.mjs", "text/javascript"], "/lib/title-piece-count.mjs": ["lib/title-piece-count.mjs", "text/javascript"], "/lib/analysis-handoff.mjs": ["lib/analysis-handoff.mjs", "text/javascript"], "/lib/analysis-coverage.mjs": ["lib/analysis-coverage.mjs", "text/javascript"] };
    const asset = assets[url.pathname];
    if (asset) return route.fulfill({ contentType: asset[1], body: await readFile(path.join(root, asset[0])) });
    if (url.pathname === "/vendor/lucide.min.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    if (url.pathname === "/api/runs") { saves.push(request.postDataJSON()); return route.fulfill({ json: { ok: true, data: { runs: [] } } }); }
    if (url.pathname === "/api/exports/analysis-handoff") {
      const payload = request.postDataJSON();
      const pack = createAnalysisHandoffPackage({ ...payload, synthetic: true, createdAt: `2026-09-09T01:00:0${packages.length}.000Z` });
      assert.deepEqual(payload.worksheet.rows.map(row => row[payload.worksheet.headers.indexOf("商品 ID")]), pack.products.map(p => p.product_id));
      packages.push(pack);
      return route.fulfill({ json: { ok: true, data: { savedFilePath: "D:\\synthetic-only\\handoff.json", packageId: pack.package_id, createdAt: pack.created_at, products: pack.products.map(p => ({ product_id: p.product_id, revision: p.revision, facts_revision: p.facts_revision, screening_revision: p.screening_revision, source_version: p.source_version })), workbook: { savedFilePath: "D:\\synthetic-only\\qualified.xlsx", imageAudit: { embedded: 0 } }, workbookError: null } } });
    }
    throw new Error(`Unexpected request in offline test: ${request.method()} ${url.pathname}`);
  });
  await page.goto("http://handoff.test/");
  await page.waitForFunction(() => Boolean(window.handoffTest));
  for (const id of ["analysisPassedCount", "analysisExcludedCount", "analysisPendingCount"]) assert.equal(await page.locator(`#${id}`).count(), 0);
  assert.equal(await page.locator("#analysisReviewedExportCount").textContent(), "0");
  assert.equal(await page.locator("#analysisCoverageStatus").textContent(), "部分完成");
  assert.match(await page.locator("#storeImportWarnings").textContent(), /其他站点/);
  for (const id of ["AU:B0SYNTH001", "AU:B0SYNTH002"]) {
    await page.locator(`#productTableBody tr[data-product-id="${id}"] .row-open-button`).click();
    await page.locator("#approveProductButton").click();
    await page.waitForFunction(id => window.handoffTest.products().find(p => p.id === id)?.reviewStatus === "approved", id);
    await page.locator("#drawerBackdrop").waitFor({ state: "hidden" });
  }
  assert.equal(await page.locator("#analysisReviewedExportCount").textContent(), "2");
  const exportViaMenu = async () => {
    if (!await page.locator("#exportMenuList").isVisible()) await page.locator("#exportButton").click();
    await page.locator("#exportAnalysisHandoffButton").click();
    await page.waitForFunction(() => !document.getElementById("exportAnalysisHandoffButton").disabled);
  };
  const firstInput = await page.evaluate(() => window.handoffTest.prepared());
  const laterInput = await page.evaluate(() => window.handoffTest.prepared());
  assert.equal(firstInput.runState.analysisCoverage.snapshot_at, laterInput.runState.analysisCoverage.snapshot_at);
  await exportViaMenu();
  await page.waitForFunction(() => window.handoffTest.products().filter(p => p.analysisHandoff?.owner === "procurement").length === 2);
  await page.waitForFunction(() => !document.getElementById("exportAnalysisHandoffButton").disabled);
  assert.equal(packages.length, 1); assert.ok(saves.length >= 2);
  const frozen = await page.evaluate(() => window.handoffTest.products()[0]);
  await page.evaluate(() => window.handoffTest.mutateBlocked());
  assert.deepEqual(await page.evaluate(() => window.handoffTest.products()[0]), frozen);
  const firstRow = page.locator('#productTableBody tr[data-product-id="AU:B0SYNTH001"]');
  await firstRow.locator(".row-open-button").click();
  assert.equal(await page.locator("#drawerAnalysisHandoffNote").isVisible(), true);
  for (const id of ["approveProductButton", "rejectProductButton", "rematchProductButton", "openManualCostButton", "editSalePrice", "editPurchaseCost", "editPieceCount", "editFbaFee", "editWeight"]) assert.equal(await page.locator(`#${id}`).isDisabled(), true, id);
  await page.locator("#closeDrawerButton").click();
  await page.locator("#drawerBackdrop").waitFor({ state: "hidden" });
  await exportViaMenu();
  await page.waitForFunction(() => !document.getElementById("exportAnalysisHandoffButton").disabled);
  assert.equal(packages.length, 2);
  assert.equal(packages[0].package_id, packages[1].package_id);
  assert.deepEqual(packages[0].products.map(p => p.revision), packages[1].products.map(p => p.revision));
  await page.evaluate(() => window.handoffTest.changeMinMargin(1));
  await exportViaMenu();
  await page.waitForFunction(() => !document.getElementById("exportAnalysisHandoffButton").disabled);
  assert.equal(packages.length, 3);
  assert.equal(packages[2].products[0].facts_revision, packages[1].products[0].facts_revision);
  assert.notEqual(packages[2].products[0].screening_revision, packages[1].products[0].screening_revision);
  assert.equal(packages[2].products[0].source_version.supersedes_revision, packages[1].products[0].revision);
  await page.evaluate(() => window.handoffTest.blockStore());
  assert.equal(await page.locator("#analysisReviewedExportCount").textContent(), "2");
  assert.equal(await page.locator("#exportAnalysisHandoffButton").isDisabled(), false, "Store screening conflicts do not rewrite an existing manual review scope");
  assert.match(await page.locator("#storeImportWarnings").textContent(), /条件冲突/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, manuallyReviewedScope: 2, realApprovalClicks: 2, exports: packages.length, snapshotPreserved: true, repeatedExportStable: true, screeningRevisionRetainsFacts: true, readOnlyControls: 9, sourceWarnings: true, platformRequests: 0 }));
} finally { await browser.close(); }
