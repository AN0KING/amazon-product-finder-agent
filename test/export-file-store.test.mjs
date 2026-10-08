import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeExportFileName, saveExportWorkbook, saveExportHandoff } from "../lib/export-file-store.mjs";

const MARKETS = ["AU", "US", "NL", "CA", "UK", "DE", "FR", "IT", "ES", "PL", "MX", "BR"];
const WORKBOOK_LABELS = ["全部候选产品", "已初审产品", "合格初筛产品"];
const HANDOFF_LABELS = ["初筛交接包", "已初审产品交接包", "已初审产品交接草稿"];
const STAMP = "20260924_123456";
const workbookName = (market = "CA", label = "已初审产品") => `Scout_${market}_${label}_${STAMP}.xlsx`;
const handoffName = (market = "CA", label = "已初审产品交接包") => `Scout_${market}_${label}_${STAMP}.json`;
const workbookBuffer = (marker) => Buffer.from(`PK\x03\x04 synthetic workbook payload: ${marker}`, "utf8");

async function temporaryDirectory(t) {
  const temporaryParent = path.resolve(tmpdir());
  const directory = path.resolve(await mkdtemp(path.join(temporaryParent, "scout-export-store-test-")));
  assert.equal(path.dirname(directory), temporaryParent);
  assert.ok(path.basename(directory).startsWith("scout-export-store-test-"));
  t.after(async () => {
    // Only remove the exact directory that this test created beneath the OS temp root.
    assert.equal(path.dirname(path.resolve(directory)), temporaryParent);
    assert.ok(path.basename(directory).startsWith("scout-export-store-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function handoffDocument(market = "CA", { draft = false, marker = "fixture" } = {}) {
  const productId = `${market}:B000000001`;
  const status = draft ? "draft" : "ready_for_procurement_review";
  return {
    package_type: "analysis_to_procurement", schema_version: "1", package_id: `synthetic-package-${marker}`, batch_id: "synthetic-export-batch",
    products: [{ product_id: productId, analysis_review_status: "approved", filter: { decision: draft ? "pending" : "pass", reasons: [] },
      preliminary_profit: { result: draft ? null : { margin: 20 }, missing_inputs: draft ? ["purchase_cost"] : [] }, missing_fields: [] }],
    manual_selection: { method: "manual_analysis_review", source_field: "reviewStatus", required_value: "approved", scope_only: true,
      business_approval: false, automatic_rules_control_selection: false, selected_count: 1, product_ids: [productId] },
    readiness: { requires_consumer_validation: true, consumer_import_compatibility: "not_verified", draft, draft_count: draft ? 1 : 0,
      ready_count: draft ? 0 : 1, status, products: [{ product_id: productId, status, reasons: [] }] },
  };
}

test("XLSX file names accept all twelve supported markets and all three workbook labels", () => {
  for (const market of MARKETS) {
    for (const label of WORKBOOK_LABELS) {
      const fileName = workbookName(market, label);
      assert.equal(normalizeExportFileName(fileName), fileName, `${market}: ${label}`);
    }
  }
});

test("JSON handoff saves accept all twelve supported markets and all three handoff labels", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const market of MARKETS) {
    for (const label of HANDOFF_LABELS) {
      const fileName = handoffName(market, label);
      const document = handoffDocument(market, { draft: label.endsWith("草稿") });
      const saved = await saveExportHandoff({ document, fileName, directory });
      assert.equal(saved.fileName, fileName);
      assert.equal(saved.directory, directory);
      assert.equal(path.dirname(saved.filePath), directory);
      assert.deepEqual(JSON.parse(await readFile(saved.filePath, "utf8")), document);
    }
  }
  assert.equal((await readdir(directory)).length, MARKETS.length * HANDOFF_LABELS.length);
});

test("CA workbook saves publish complete bytes and concurrent name collisions preserve every original", async (t) => {
  const directory = await temporaryDirectory(t);
  const fileName = workbookName();
  const originalBytes = workbookBuffer("original");
  const original = await saveExportWorkbook({ buffer: originalBytes, fileName, directory });
  const additionalBytes = [workbookBuffer("second"), workbookBuffer("third")];
  const additional = await Promise.all(additionalBytes.map((buffer) => saveExportWorkbook({ buffer, fileName, directory })));
  assert.equal(original.fileName, fileName);
  assert.deepEqual(await readFile(original.filePath), originalBytes);
  const stem = fileName.slice(0, -5);
  assert.deepEqual(additional.map((saved) => saved.fileName).sort(), [`${stem}_2.xlsx`, `${stem}_3.xlsx`]);
  for (let index = 0; index < additional.length; index += 1) {
    assert.equal(path.dirname(additional[index].filePath), directory);
    assert.deepEqual(await readFile(additional[index].filePath), additionalBytes[index]);
  }
  assert.deepEqual((await readdir(directory)).sort(), [fileName, `${stem}_2.xlsx`, `${stem}_3.xlsx`].sort());
});

test("CA handoff name collisions retain both JSON documents without replacing the first", async (t) => {
  const directory = await temporaryDirectory(t);
  const fileName = handoffName();
  const firstDocument = handoffDocument("CA", { marker: "first" });
  const secondDocument = handoffDocument("CA", { marker: "second" });
  const first = await saveExportHandoff({ document: firstDocument, fileName, directory });
  const firstBytes = await readFile(first.filePath);
  const second = await saveExportHandoff({ document: secondDocument, fileName, directory });
  assert.equal(first.fileName, fileName);
  assert.equal(second.fileName, fileName.replace(/\.json$/, "_2.json"));
  assert.equal(path.dirname(second.filePath), directory);
  assert.deepEqual(await readFile(first.filePath), firstBytes);
  assert.deepEqual(JSON.parse(await readFile(first.filePath, "utf8")), firstDocument);
  assert.deepEqual(JSON.parse(await readFile(second.filePath, "utf8")), secondDocument);
  assert.deepEqual((await readdir(directory)).sort(), [first.fileName, second.fileName].sort());
});

test("XLSX saving rejects traversal, unsupported markets and other extensions before creating files", async (t) => {
  const directory = await temporaryDirectory(t);
  const valid = workbookName();
  const invalidNames = [
    `../${valid}`, `..\\${valid}`, `nested/${valid}`, `nested\\${valid}`, `C:\\exports\\${valid}`, `/${valid}`,
    workbookName("JP"), workbookName("ZZ"), workbookName("ca"), valid.replace(/\.xlsx$/, ".xlsm"),
    valid.replace(/\.xlsx$/, ".json"), `${valid}.exe`, ` ${valid}`, `${valid} `,
  ];
  for (const fileName of invalidNames) {
    assert.throws(() => normalizeExportFileName(fileName), { code: "INVALID_EXPORT_FILE_NAME", status: 400 }, fileName);
    await assert.rejects(saveExportWorkbook({ buffer: workbookBuffer("rejected"), fileName, directory }), { code: "INVALID_EXPORT_FILE_NAME", status: 400 }, fileName);
  }
  assert.deepEqual(await readdir(directory), []);
});

test("handoff saving independently rejects traversal, unsupported markets and non-JSON extensions", async (t) => {
  const directory = await temporaryDirectory(t);
  const valid = handoffName();
  const document = handoffDocument();
  const invalidNames = [
    `../${valid}`, `..\\${valid}`, `nested/${valid}`, `nested\\${valid}`, `C:\\exports\\${valid}`, `/${valid}`,
    handoffName("JP"), handoffName("ZZ"), handoffName("ca"), valid.replace(/\.json$/, ".xlsx"),
    valid.replace(/\.json$/, ".txt"), `${valid}.exe`, ` ${valid}`, `${valid} `,
  ];
  for (const fileName of invalidNames) {
    await assert.rejects(saveExportHandoff({ document, fileName, directory }), { code: "INVALID_EXPORT_FILE_NAME", status: 400 }, fileName);
  }
  assert.deepEqual(await readdir(directory), []);
});
