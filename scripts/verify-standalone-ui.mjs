// Isolated browser acceptance. Every HTTP request is intercepted; no platform work runs.
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
// Begin with unreviewed local products, independent of shared export fixture defaults.
fixture.products.forEach(product => { product.reviewStatus = "pending"; });
const origin = "http://standalone.test";
const readonlyIds = ["approveProductButton", "rejectProductButton", "rematchProductButton", "openManualCostButton", "editSalePrice", "editPurchaseCost", "editPieceCount", "editFbaFee", "editWeight"];
const assets = { "/": ["index.html", "text/html"], "/styles.css": ["styles.css", "text/css"], "/lib/profit-model.mjs": ["lib/profit-model.mjs", "text/javascript"], "/lib/title-piece-count.mjs": ["lib/title-piece-count.mjs", "text/javascript"], "/lib/analysis-handoff.mjs": ["lib/analysis-handoff.mjs", "text/javascript"], "/lib/analysis-coverage.mjs": ["lib/analysis-coverage.mjs", "text/javascript"] };
const storeData = {
  fileName: "synthetic-standalone.xlsx",
  audit: { marketplace: "AU", rawRows: 1, uniqueSellers: 1, duplicates: 0, repaired: 0, invalid: 0 },
  stores: [{ sellerId: "A1SYNTHETIC001", sellerName: "Synthetic Independent Store", marketplace: "AU", rowNumbers: [2], criteria: {}, sellerUrl: "https://www.amazon.com.au/s?me=A1SYNTHETIC001" }],
  rejectedRows: [], issues: [],
};
const testSource = source.replace('document.addEventListener("DOMContentLoaded", init);', `
  document.addEventListener("DOMContentLoaded", () => {
    const fixture = ${JSON.stringify(fixture)};
    activeMarket = MARKET_CONFIGS.AU;
    runState = { ...createIdleRunState(), ...fixture.runState, mode: "live", startedAt: fixture.createdAt, completedAt: fixture.createdAt };
    activeRunCriteria = fixture.criteria.amazon;
    storeList = { audit: { marketplace: "AU", uniqueSellers: 1, rawRows: 1 }, stores: [{ sellerId: "SYNTHETIC_SELLER_A", sellerName: "Synthetic AU Store", marketplace: "AU", rowNumbers: [2], criteria: {} }], rejectedRows: [] };
    const seed = hydrateFallbackProducts().find(item => Number.isFinite(item.margin));
    products = fixture.products.map(item => ({ ...structuredClone(seed), ...item, name: item.englishName, dataMode: "live", imageUrl: null }));
    renderMarketUi(); applyStoredCriteriaToInputs(activeRunCriteria, false);
    byId("resultMinMargin").value = "0";
    products.forEach(updateProductComputed);
    bindNavigation(); bindResults(); bindDrawer(); bindManualCostDialog(); bindDialogs(); showView("results");
    window.standaloneTest = {
      products: () => structuredClone(products),
      snapshot: () => structuredClone(captureRunSnapshot()),
      prepared: buildAnalysisHandoffInput,
      exportNow: exportAnalysisHandoff,
      exporting: () => exportRunning,
      readOnly: id => isAnalysisReadOnly(products.find(p => p.id === id)),
      changeMinMargin: value => { byId("resultMinMargin").value = String(value); renderResults(); },
      mutateBlocked: () => { const p = products[0]; apply1688SearchResult(p, {}); refreshProductWeightState(p); applyAutomaticFba(p); refreshSupplierTarget(p); updateProductComputed(p); },
      eligibleWithoutExistingQuote: id => {
        const p = products.find(item => item.id === id), before = structuredClone(p);
        try {
          p.imageUrl = "http://standalone.test/synthetic-image.png";
          p.supplierSearchStatus = "not_started"; p.manualPurchaseCost = false;
          return getAmazonFilteredProductsFor1688().some(item => item.id === id);
        } finally { for (const key of Object.keys(p)) delete p[key]; Object.assign(p, before); }
      },
    };
  });
`);
assert.notEqual(testSource, source, "Production init marker must remain available to the isolated harness");

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release, entered: false };
}

async function openHarness(browser, { originalInit = false, latestRun = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const state = { errors: [], unexpected: [], external: [], requests: [], saves: [], packages: [], failNextSave: false, saveGate: null, exportGate: null };
  page.on("pageerror", error => state.errors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { state.external.push(request.url()); return route.abort(); }
    if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: originalInit ? source : testSource });
    const asset = assets[url.pathname];
    if (asset) return route.fulfill({ contentType: asset[1], body: await readFile(path.join(root, asset[0])) });
    if (url.pathname === "/vendor/lucide.min.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
    state.requests.push({ method: request.method(), path: url.pathname });
    const reply = data => route.fulfill({ json: { ok: true, data } });
    if (url.pathname === "/api/state") return reply({ runs: [], latestRun, amazonConnectionChecks: {}, totalSellerSpriteCalls: 0 });
    if (url.pathname === "/api/version") return reply({ version: "0.9.30", connected: false });
    if (url.pathname === "/api/v1/runtime") return reply({ auth: { ready: false, checking: false, reason: "service_unavailable", message: "Isolated test: procurement is offline" }, queue: {} });
    if (url.pathname === "/api/runtime/heartbeat") return reply({ active: true });
    if (url.pathname === "/api/store-list/default" || url.pathname === "/api/store-list/parse") return reply(storeData);
    if (url.pathname === "/api/runs") {
      state.saves.push(request.postDataJSON());
      if (state.saveGate) { const pending = state.saveGate; pending.entered = true; await pending.promise; }
      if (state.failNextSave) {
        state.failNextSave = false;
        return route.fulfill({ status: 500, json: { ok: false, error: { code: "SYNTHETIC_SAVE_FAILED", message: "Synthetic save failed; original snapshot must remain locked" } } });
      }
      return reply({ runs: [] });
    }
    if (url.pathname === "/api/exports/analysis-handoff") {
      const payload = request.postDataJSON();
      const pack = createAnalysisHandoffPackage({ ...payload, synthetic: true, createdAt: new Date(Date.UTC(2026, 8, 9, 1, 0, state.packages.length)).toISOString() });
      assert.deepEqual(payload.worksheet.rows.map(row => row[payload.worksheet.headers.indexOf("商品 ID")]), pack.products.map(p => p.product_id));
      state.packages.push(pack);
      if (state.exportGate) { const pending = state.exportGate; pending.entered = true; await pending.promise; }
      return reply({ savedFilePath: "D:\\synthetic-only\\handoff.json", packageId: pack.package_id, createdAt: pack.created_at, products: pack.products.map(p => ({ product_id: p.product_id, revision: p.revision, facts_revision: p.facts_revision, screening_revision: p.screening_revision, source_version: p.source_version })), workbook: { savedFilePath: "D:\\synthetic-only\\qualified.xlsx", imageAudit: { embedded: 0 } }, workbookError: null });
    }
    state.unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 599, json: { ok: false, error: { message: "Unexpected request blocked by offline acceptance" } } });
  });
  await page.goto(origin);
  if (!originalInit) await page.waitForFunction(() => Boolean(window.standaloneTest));
  return { context, page, state };
}

async function assertControls(page, disabled) {
  for (const id of readonlyIds) assert.equal(await page.locator(`#${id}`).isDisabled(), disabled, `${id} ${disabled ? "locked" : "editable"}`);
}

async function waitForExport(page) {
  await page.waitForFunction(() => !window.standaloneTest.exporting());
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.SCOUT_TEST_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
try {
  const { page, state, context } = await openHarness(browser);
  const productId = "AU:B0SYNTH001";
  const normalSnapshot = await page.evaluate(() => window.standaloneTest.snapshot());
  assert.equal(await page.locator("#analysisReviewedExportCount").textContent(), "0");
  for (const id of [productId, "AU:B0SYNTH002"]) {
    await page.locator(`#productTableBody tr[data-product-id="${id}"] .row-open-button`).click();
    await page.locator("#approveProductButton").click();
    await page.waitForFunction(id => window.standaloneTest.products().find(p => p.id === id)?.reviewStatus === "approved", id);
    await page.locator("#drawerBackdrop").waitFor({ state: "hidden" });
  }
  assert.equal(await page.locator("#analysisReviewedExportCount").textContent(), "2");
  await page.locator("#exportButton").click();
  await page.locator("#exportAnalysisHandoffButton").click();
  await waitForExport(page);
  assert.equal(state.packages.length, 1);
  await page.locator(`#productTableBody tr[data-product-id="${productId}"] .row-open-button`).click();
  await assertControls(page, true);
  assert.equal(await page.locator("#newAnalysisVersionButton").isVisible(), true);
  assert.equal(await page.locator("#newAnalysisVersionButton").isDisabled(), false);
  const frozen = await page.evaluate(() => window.standaloneTest.products()[0]);
  await page.evaluate(() => window.standaloneTest.mutateBlocked());
  assert.deepEqual(await page.evaluate(() => window.standaloneTest.products()[0]), frozen);
  assert.equal(await page.evaluate(id => window.standaloneTest.eligibleWithoutExistingQuote(id), productId), false);

  // A failed local checkpoint cannot unlock or change the exported snapshot.
  state.failNextSave = true;
  const beforeFailure = state.saves.length;
  await page.locator("#newAnalysisVersionButton").click();
  await page.waitForFunction(() => !document.getElementById("newAnalysisVersionButton").disabled);
  assert.equal(state.saves.length, beforeFailure + 1);
  assert.deepEqual(await page.evaluate(() => window.standaloneTest.products()[0]), frozen);
  await assertControls(page, true);
  assert.match(await page.locator("#toast").textContent(), /失败|未保存|未创建|重试/);

  // Hold checkpoint acknowledgement: no controls may unlock early and a second click is ignored.
  state.saveGate = gate();
  const beforeCreate = state.saves.length;
  await page.locator("#newAnalysisVersionButton").click();
  await page.waitForFunction(() => document.getElementById("newAnalysisVersionButton").disabled);
  await assertControls(page, true);
  assert.equal(await page.evaluate(id => window.standaloneTest.readOnly(id), productId), true);
  await page.evaluate(() => document.getElementById("newAnalysisVersionButton").click());
  assert.equal(state.saves.length, beforeCreate + 1);
  state.saveGate.release(); state.saveGate = null;
  await page.waitForFunction(() => window.standaloneTest.products()[0].analysisHandoff?.owner === "analysis" && !window.standaloneTest.readOnly(window.standaloneTest.products()[0].id));
  await assertControls(page, false);
  const draft = await page.evaluate(() => window.standaloneTest.products()[0]);
  assert.equal(draft.id, frozen.id); assert.equal(draft.asin, frozen.asin);
  assert.equal(draft.reviewStatus, "pending");
  assert.equal(await page.locator("#analysisReviewedExportCount").textContent(), "1", "A new draft must be manually reviewed again before joining the handoff scope");
  assert.equal(draft.analysisHistory.length, 1);
  assert.deepEqual(draft.analysisHistory[0].product, frozen);
  assert.equal(draft.analysisHistory[0].product.analysisHistory, undefined);
  assert.equal(draft.analysisDraft.version, 2);
  assert.equal(draft.analysisDraft.basedOnRevision, frozen.analysisHandoff.revision);
  for (const key of ["revision", "facts_revision", "screening_revision", "source_version", "savedFilePath"]) assert.deepEqual(draft.analysisHandoff[key], frozen.analysisHandoff[key]);
  assert.equal(draft.analysisProfitInputs, undefined); assert.equal(draft.resolvedProfitInputs, undefined);
  assert.equal(await page.evaluate(id => window.standaloneTest.eligibleWithoutExistingQuote(id), productId), true);
  assert.equal(await page.locator("#analysisVersionHistory").isVisible(), true);

  // The real manual-cost dialog and inline editor both change the new draft's profit.
  const originalMargin = draft.margin;
  await page.locator("#openManualCostButton").click();
  await page.locator("#manualPurchaseCost").fill("4");
  await page.locator("#saveManualCostButton").click();
  await page.waitForFunction(() => window.standaloneTest.products()[0].purchaseUnitCostCny === 4);
  await page.locator("#manualCostDialog").waitFor({ state: "hidden" });
  let edited = await page.evaluate(() => window.standaloneTest.products()[0]);
  assert.notEqual(edited.margin, originalMargin);
  assert.deepEqual(edited.analysisHistory[0].product, frozen);
  await page.locator("#profitTab").click();
  const beforeInlineMargin = edited.margin;
  await page.locator("#editPurchaseCost").fill("5");
  await page.waitForFunction(() => window.standaloneTest.products()[0].purchaseUnitCostCny === 5);
  edited = await page.evaluate(() => window.standaloneTest.products()[0]);
  assert.notEqual(edited.margin, beforeInlineMargin);
  assert.deepEqual(edited.analysisHistory[0].product, frozen);
  await page.evaluate(() => window.standaloneTest.changeMinMargin(100));
  assert.equal(await page.locator("#analysisReviewedExportCount").textContent(), "1");
  await page.evaluate(() => window.standaloneTest.changeMinMargin(0));
  assert.equal(await page.locator("#analysisReviewedExportCount").textContent(), "1");

  // Editing a new version does not approve it. Only the actual review action restores scope.
  await page.locator("#approveProductButton").click();
  await page.waitForFunction(id => window.standaloneTest.products().find(p => p.id === id)?.reviewStatus === "approved", productId);
  await page.locator("#drawerBackdrop").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#analysisReviewedExportCount").textContent(), "2");
  await page.locator(`#productTableBody tr[data-product-id="${productId}"] .row-open-button`).click();

  // Rehandoff retains a predecessor, locks the draft, and leaves the archive untouched.
  await page.evaluate(() => window.standaloneTest.exportNow());
  await waitForExport(page);
  assert.equal(state.packages.length, 2);
  const previousRecord = state.packages[0].products.find(p => p.product_id === productId);
  const revisedRecord = state.packages[1].products.find(p => p.product_id === productId);
  assert.notEqual(revisedRecord.facts_revision, previousRecord.facts_revision);
  assert.equal(revisedRecord.source_version.supersedes_revision, previousRecord.revision);
  assert.equal(revisedRecord.preliminary_profit.inputs.salePrice, draft.salePrice);
  assert.equal(revisedRecord.preliminary_profit.inputs.purchaseCostCny, 10);
  const revised = await page.evaluate(() => window.standaloneTest.products()[0]);
  assert.equal(revised.analysisHandoff.owner, "procurement");
  assert.deepEqual(revised.analysisHistory[0].product, frozen);
  await assertControls(page, true);
  // While another export is in flight, creating another draft is blocked.
  state.exportGate = gate();
  await page.evaluate(() => { void window.standaloneTest.exportNow(); });
  await page.waitForFunction(() => window.standaloneTest.exporting());
  assert.equal(await page.locator("#newAnalysisVersionButton").isDisabled(), true);
  await page.evaluate(() => document.getElementById("newAnalysisVersionButton").click());
  assert.deepEqual((await page.evaluate(() => window.standaloneTest.products()[0])).analysisHistory, revised.analysisHistory);
  state.exportGate.release(); state.exportGate = null;
  await waitForExport(page);
  assert.equal(state.packages.length, 3);
  assert.equal(state.packages[2].package_id, state.packages[1].package_id);
  assert.deepEqual(state.packages[2].products.map(p => p.revision), state.packages[1].products.map(p => p.revision));
  // A later draft appends one flat historical snapshot instead of recursively nesting prior history.
  const beforeThirdVersion = await page.evaluate(() => window.standaloneTest.products()[0]);
  await page.locator("#newAnalysisVersionButton").click();
  await page.waitForFunction(() => window.standaloneTest.products()[0].analysisDraft?.version === 3 && !window.standaloneTest.readOnly(window.standaloneTest.products()[0].id));
  const thirdVersion = await page.evaluate(() => window.standaloneTest.products()[0]);
  const previousWithoutHistory = structuredClone(beforeThirdVersion);
  delete previousWithoutHistory.analysisHistory;
  assert.equal(thirdVersion.analysisHistory.length, 2);
  assert.deepEqual(thirdVersion.analysisHistory[0].product, frozen);
  assert.deepEqual(thirdVersion.analysisHistory[1].product, previousWithoutHistory);
  assert.equal(thirdVersion.analysisHistory[1].product.analysisHistory, undefined);
  assert.equal(thirdVersion.analysisDraft.basedOnRevision, revisedRecord.revision);
  assert.deepEqual(state.errors, []); assert.deepEqual(state.unexpected, []); assert.deepEqual(state.external, []);
  await context.close();

  // A separate page runs the unmodified production init, with no director package or procurement service.
  const initial = await openHarness(browser, { originalInit: true });
  await initial.page.waitForFunction(() => document.getElementById("uniqueStoresMetric").textContent.trim() === "1");
  assert.equal(await initial.page.evaluate(() => "standaloneTest" in window), false);
  assert.equal(await initial.page.locator("#storeFileInput").isDisabled(), false);
  await initial.page.locator("#useSellerSpriteToggle").uncheck();
  assert.equal(await initial.page.locator("#startAnalysisButton").isDisabled(), false);
  await initial.page.locator("#storeFileInput").setInputFiles({ name: "synthetic-import.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("Synthetic parser fixture; parsed response is mocked") });
  await initial.page.waitForFunction(() => document.getElementById("uploadedFilename").textContent === "synthetic-import.xlsx" && !document.getElementById("startAnalysisButton").disabled);
  assert.equal(initial.state.requests.filter(r => r.path === "/api/store-list/parse").length, 1);
  await initial.page.locator("#storeManagerToggle").click();
  assert.match(await initial.page.locator("#currentStoreList").textContent(), /Synthetic Independent Store/);
  assert.equal(await initial.page.locator("#clearStoreListButton").isDisabled(), false);
  assert.deepEqual(initial.state.errors, []); assert.deepEqual(initial.state.unexpected, []); assert.deepEqual(initial.state.external, []);
  await initial.context.close();

  // Ordinary locally saved analysis remains editable when launched independently through original init.
  const independentSnapshot = structuredClone(normalSnapshot);
  independentSnapshot.products = independentSnapshot.products.slice(0, 1);
  independentSnapshot.runState.analysisSourceMode = "synthetic_local_saved_analysis";
  const restored = await openHarness(browser, { originalInit: true, latestRun: independentSnapshot });
  await restored.page.locator('[data-view-target="results"]').first().click();
  await restored.page.locator(`#productTableBody tr[data-product-id="${productId}"] .row-open-button`).click();
  assert.equal(await restored.page.locator("#openManualCostButton").isDisabled(), false);
  await restored.page.locator("#openManualCostButton").click();
  await restored.page.locator("#manualPurchaseCost").fill("5");
  await restored.page.locator("#saveManualCostButton").click();
  await restored.page.locator("#manualCostDialog").waitFor({ state: "hidden" });
  assert.ok(restored.state.saves.some(s => s.products?.[0]?.purchaseUnitCostCny === 5));
  assert.deepEqual(restored.state.errors, []); assert.deepEqual(restored.state.unexpected, []); assert.deepEqual(restored.state.external, []);
  await restored.context.close();
  console.log(JSON.stringify({ ok: true, creationFailureRollback: true, saveBeforeUnlock: true, duplicateCreationBlocked: true, editableControlsRestored: readonlyIds.length, oldSnapshotPreserved: true, flatHistoryAcrossVersions: true, liveProfitEdits: true, draftFilterAndMatchEligibility: true, newVersionRequiresManualReview: true, realApprovalClicks: 3, rehandoffPredecessor: true, repeatExportStable: true, standaloneOriginalInit: true, independentImportAndManualCosts: true, platformRequests: 0 }));
} finally { await browser.close(); }
