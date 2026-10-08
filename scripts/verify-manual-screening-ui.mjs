// Isolated A03 acceptance: 944 synthetic products; every request is intercepted.
// No actual Amazon/1688 requests, saved runs, spreadsheets, or handoff files are created.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { classifyAnalysisProducts, createAnalysisHandoffPackage } from "../lib/analysis-handoff.mjs";
import { syntheticAnalysisInput, syntheticProduct, syntheticProfitInputs } from "../integration/analysis/synthetic-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.SCOUT_TEST_PLAYWRIGHT || "D:/deliverables/1688-procurement-assistant-2.3.0/node_modules/playwright-core/index.mjs"));
const source = await readFile(path.join(root, "app.js"), "utf8");
const origin = "http://manual-screening.test";
const fixture = syntheticAnalysisInput();
fixture.runState.id = "synthetic-manual-screening-944";
fixture.criteria.results.minMargin = null;
fixture.products = Array.from({ length: 944 }, (_, index) => {
  const asin = `B0A${String(index + 1).padStart(7, "0")}`;
  return syntheticProduct({
    id: `AU:${asin}`, asin, sourceAsin: asin, sourceAsins: [asin],
    englishName: `Synthetic Product ${index + 1} 2 Pieces Storage Bags`,
    imageUrl: null, sales30: index < 795 ? 100 : 30,
    detailStatus: index >= 2 && index < 130 ? "success" : "pending",
    reviewStatus: index < 2 ? "approved" : "pending",
    manualPurchaseCost: true, supplierSearchStatus: "not_started",
    // Deliberately exercise legacy saved approvals: one is below the rule margin,
    // another has missing profit inputs. Neither may silently leave manual scope.
    ...(index === 0 ? { detailStatus: "success", purchaseCost: 200, purchaseUnitCostCny: 100,
      analysisProfitInputs: { ...syntheticProfitInputs, purchaseCostCny: 200 } } : {}),
    ...(index === 1 ? { productWeight: null, billingWeight: null, fbaWeight: null,
      complete: false, missing: ["商品重量"],
      analysisProfitInputs: { ...syntheticProfitInputs, actualWeightKg: null } } : {}),
  });
});
const expectedIds = fixture.products.slice(0, 2).map(p => p.id);
const allIds = fixture.products.map(p => p.id);
const initialStatuses = fixture.products.map(p => [p.id, p.reviewStatus]);
// Rule output is an independent reference, never the export-selection fixture.
assert.equal(classifyAnalysisProducts({ ...fixture, criteria: { ...fixture.criteria, results: { ...fixture.criteria.results, minMargin: 0 } } }).passed.length, 128);

const testSource = source.replace('document.addEventListener("DOMContentLoaded", init);', `
  document.addEventListener("DOMContentLoaded", () => {
    const fixture = ${JSON.stringify(fixture)};
    activeMarket = MARKET_CONFIGS.AU;
    runState = { ...createIdleRunState(), ...fixture.runState, mode: "live", startedAt: fixture.createdAt };
    activeRunCriteria = fixture.criteria.amazon;
    storeList = { audit: { marketplace: "AU", uniqueSellers: 1, rawRows: 1 },
      stores: [{ sellerId: "SYNTHETIC_SELLER_A", sellerName: "Synthetic AU Store", marketplace: "AU", rowNumbers: [2], criteria: {} }], rejectedRows: [] };
    const seed = hydrateFallbackProducts().find(p => Number.isFinite(p.margin));
    products = fixture.products.map(p => ({ ...structuredClone(seed), ...p, name: p.englishName, dataMode: "live", imageUrl: null }));
    renderMarketUi(); applyStoredCriteriaToInputs(activeRunCriteria, false);
    byId("resultMinMargin").value = ""; byId("resultsCompleteToggle").checked = false;
    products.forEach(updateProductComputed);
    bindResults(); bindDrawer(); showView("results");
    window.manualScreeningTest = {
      products: () => structuredClone(products),
      prepared: buildAnalysisHandoffInput,
      exporting: () => exportRunning,
    };
  });
`);
assert.notEqual(testSource, source);

const assets = { "/": ["index.html", "text/html"], "/styles.css": ["styles.css", "text/css"], "/lib/profit-model.mjs": ["lib/profit-model.mjs", "text/javascript"], "/lib/title-piece-count.mjs": ["lib/title-piece-count.mjs", "text/javascript"], "/lib/analysis-handoff.mjs": ["lib/analysis-handoff.mjs", "text/javascript"], "/lib/analysis-coverage.mjs": ["lib/analysis-coverage.mjs", "text/javascript"] };
const spreadsheetIds = payload => payload.rows.map(row => row[payload.headers.indexOf("商品 ID")]);
const browser = await chromium.launch({ headless: true, executablePath: process.env.SCOUT_TEST_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const state = { errors: [], unexpected: [], external: [], spreadsheets: [], handoffs: [], packages: [], saves: [] };
  page.on("pageerror", error => state.errors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { state.external.push(request.url()); return route.abort(); }
    if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: testSource });
    const asset = assets[url.pathname];
    if (asset) return route.fulfill({ contentType: asset[1], body: await readFile(path.join(root, asset[0])) });
    if (url.pathname === "/vendor/lucide.min.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
    const reply = data => route.fulfill({ json: { ok: true, data } });
    if (url.pathname === "/api/runs") { state.saves.push(request.postDataJSON()); return reply({ runs: [] }); }
    if (url.pathname === "/api/exports/xlsx") {
      state.spreadsheets.push(request.postDataJSON());
      return reply({ savedFilePath: "D:\\synthetic-only\\manual-range.xlsx", imageAudit: { embedded: 0, missing: 0, failed: 0 } });
    }
    if (url.pathname === "/api/exports/analysis-handoff") {
      const payload = request.postDataJSON();
      const pack = createAnalysisHandoffPackage({ ...payload, synthetic: true, createdAt: new Date(Date.UTC(2026, 8, 9, 3, 0, state.packages.length)).toISOString() });
      state.handoffs.push(payload); state.packages.push(pack);
      return reply({ savedFilePath: "D:\\synthetic-only\\manual-handoff.json", packageId: pack.package_id, createdAt: pack.created_at,
        products: pack.products.map(p => ({ product_id: p.product_id, revision: p.revision, facts_revision: p.facts_revision, screening_revision: p.screening_revision, source_version: p.source_version })),
        workbook: { savedFilePath: "D:\\synthetic-only\\manual-handoff.xlsx", imageAudit: { embedded: 0 } }, workbookError: null });
    }
    state.unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 599, json: { ok: false, error: { message: "Unexpected request blocked by offline acceptance" } } });
  });

  const statuses = () => page.evaluate(() => window.manualScreeningTest.products().map(p => [p.id, p.reviewStatus]));
  const exportViaMenu = async id => {
    if (!await page.locator("#exportMenuList").isVisible()) await page.locator("#exportButton").click();
    await page.locator(`#${id}`).click();
    await page.waitForFunction(() => !window.manualScreeningTest.exporting());
  };
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(window.manualScreeningTest));
  for (const id of ["analysisPassedCount", "analysisExcludedCount", "analysisPendingCount"]) assert.equal(await page.locator(`#${id}`).count(), 0, `No automatic ${id} card`);
  assert.equal(await page.locator("#analysisCoverageStatus").isVisible(), true);
  assert.equal(await page.locator("#totalCandidateCount").textContent(), "944");
  assert.equal(await page.locator("#visibleCount").textContent(), "795");
  assert.equal(await page.locator("#exportApprovedProductCount").textContent(), "2");
  assert.equal(await page.locator("#analysisReviewedExportCount").textContent(), "2");
  assert.equal(await page.locator("#exportAnalysisHandoffButton").isVisible(), false, "Optional handoff starts inside the closed export menu");
  assert.match(await page.locator("#exportAnalysisHandoffButton").textContent(), /已初审产品交接包.*可选/);
  assert.equal(state.spreadsheets.length, 0); assert.equal(state.packages.length, 0);
  assert.deepEqual(await statuses(), initialStatuses);
  assert.equal((await page.evaluate(() => window.manualScreeningTest.prepared())).products.length, 944, "Default preparation retains all source products");

  await exportViaMenu("exportAllCandidatesButton");
  assert.equal(state.spreadsheets.length, 1);
  assert.deepEqual(spreadsheetIds(state.spreadsheets[0]), allIds);
  await exportViaMenu("exportApprovedProductsButton");
  assert.equal(state.spreadsheets.length, 2);
  assert.deepEqual(spreadsheetIds(state.spreadsheets[1]), expectedIds);
  assert.deepEqual(await statuses(), initialStatuses);

  // A real input event changes visible results; it cannot change human review scope.
  await page.locator("#resultMinMargin").fill("1000");
  assert.equal(await page.locator("#visibleCount").textContent(), "0");
  assert.equal(await page.locator("#exportApprovedProductCount").textContent(), "2");
  assert.equal(await page.locator("#analysisReviewedExportCount").textContent(), "2");
  assert.equal(state.spreadsheets.length, 2); assert.equal(state.packages.length, 0);
  assert.deepEqual(await statuses(), initialStatuses);
  await exportViaMenu("exportApprovedProductsButton");
  assert.deepEqual(spreadsheetIds(state.spreadsheets[2]), expectedIds);

  await exportViaMenu("exportAnalysisHandoffButton");
  assert.equal(state.packages.length, 1);
  const pack = state.packages[0];
  assert.deepEqual(state.handoffs[0].products.map(p => p.id), expectedIds, "Only the manually approved snapshots are submitted");
  assert.deepEqual(spreadsheetIds(state.handoffs[0].worksheet), expectedIds);
  assert.deepEqual(pack.products.map(p => p.product_id), expectedIds);
  assert.equal(pack.manual_selection.method, "manual_analysis_review");
  assert.equal(pack.manual_selection.source_field, "reviewStatus");
  assert.equal(pack.manual_selection.selected_count, 2);
  assert.deepEqual([...pack.manual_selection.product_ids].sort(), [...expectedIds].sort());
  assert.ok(pack.products[0].preliminary_profit.result.margin < 0, "Low profit remains present");
  assert.equal(pack.products[1].preliminary_profit.result, null, "Missing inputs remain explicit, not zero/default profit");
  assert.equal(pack.products[1].preliminary_profit.inputs.actualWeightKg, null);
  assert.equal(pack.readiness.status, "draft");
  assert.ok(pack.readiness.draft_count >= 1);
  assert.deepEqual(await statuses(), initialStatuses, "Handoff does not auto-approve the rule subset or alter review decisions");

  await exportViaMenu("exportAnalysisHandoffButton");
  assert.equal(state.packages.length, 2);
  assert.deepEqual(state.packages[1].products.map(p => p.product_id), expectedIds);
  assert.deepEqual(spreadsheetIds(state.handoffs[1].worksheet), expectedIds);
  assert.equal(state.packages[1].package_id, pack.package_id);
  assert.deepEqual(state.packages[1].products.map(p => p.revision), pack.products.map(p => p.revision));
  assert.deepEqual(await statuses(), initialStatuses);
  assert.deepEqual(state.errors, []); assert.deepEqual(state.unexpected, []); assert.deepEqual(state.external, []);
  console.log(JSON.stringify({ ok: true, totalCandidates: 944, automaticRuleReference: 128, initiallyVisible: 795, manuallyReviewed: 2, originalAllExport: 944, approvedExportStableAfterFilter: true, optionalHandoffScope: 2, incompleteHandoffIsDraft: true, automaticCards: 0, automaticExports: 0, reviewStatusesPreserved: true, repeatExportStable: true, platformRequests: 0 }));
} finally { await browser.close(); }
