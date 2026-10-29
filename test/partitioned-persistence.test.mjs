import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readPartitionedRun, writePartitionedRun } from "../lib/partitioned-run-file.mjs";
import { recomputeProductProfit } from "../lib/product-profit-state.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "scout-partition-test-"));
const previousData = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(root, "default");
const { PersistenceStore } = await import("../lib/persistence-store.mjs");
if (previousData === undefined) delete process.env.SCOUT_DATA_DIR;
else process.env.SCOUT_DATA_DIR = previousData;
after(async () => {
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith("scout-partition-test-"));
  await rm(root, { recursive: true, force: true });
});
const asin = "B000000001";
const legacy = (id) => ({
  schemaVersion: 1, id, status: "running", marketplace: "AU", updatedAt: "2026-10-13T00:00:00Z",
  searchBatches: [{ phase: "analyze", productCount: 1, audit: "historical-audit-".repeat(100000) }],
  asinDetails: { "AU:B000000001": { data: { currentPrice: 15 }, status: "success" } },
  competitorLookups: { saved: { data: { sales30: 100 } } },
  amazonStoreCheckpoints: { saved: { asins: [asin], marketplace: "AU", sellerId: "SAVEDSHOP" } },
  amazonCollection: { job: { revision: 1, status: "running", enabled: true, tasks: { [asin]: { status: "complete" } } }, items: {} },
  snapshot: { products: [{ id: `AU:${asin}`, asin, currentPrice: 12, manualAmazonFields: { currentPrice: true }, manualPurchaseCost: true, purchaseCost: 18, weightSource: "娴溠冩惂娴滃搫浼愮憰鍡欐磰", billingWeight: 0.2, suppliers: [{ unitPriceCny: 18 }] }],
    runState: { id, marketplace: "AU", mode: "live", supplier1688Pipeline: { status: "paused", revision: 2, enabled: false } }, storeList: { stores: [] } },
});
async function seeded(id) {
  const store = new PersistenceStore({ directory: path.join(root, id) });
  await store.ready();
  const document = legacy(id);
  await writeFile(store.runPath(id), JSON.stringify(document));
  return { store, document, file: store.runPath(id) };
}

test("legacy reads do not migrate; first normal write partitions without losing payload", async () => {
  const { store, document, file } = await seeded("legacy");
  const original = await readFile(file, "utf8");
  assert.deepEqual(await store.getAmazonCollectionJob("legacy"), document.amazonCollection.job);
  assert.equal(await readFile(file, "utf8"), original);
  await store.updateAmazonCollectionJob("legacy", job => { job.status = "paused"; job.enabled = false; job.revision++; });
  const manifest = JSON.parse(await readFile(file, "utf8"));
  assert.equal(manifest.runPartitions.version, 1);
  assert.ok((await stat(file)).size < 4096);
  const full = await readPartitionedRun(file, { sections: "all" });
  assert.deepEqual(full.searchBatches, document.searchBatches);
  assert.deepEqual(full.snapshot.products, document.snapshot.products);
  assert.deepEqual(full.asinDetails, document.asinDetails);
  assert.deepEqual(full.competitorLookups, document.competitorLookups);
  assert.deepEqual(full.amazonStoreCheckpoints, document.amazonStoreCheckpoints);
  assert.equal(full.amazonCollection.job.status, "paused");
  const restarted = new PersistenceStore({ directory: store.directory });
  assert.equal((await restarted.getAmazonCollectionJob("legacy")).status, "paused");
});

test("job and supplier status do not load giant audit, item or product partitions", async () => {
  const { store, file, document } = await seeded("control");
  await store.writeRunFile("control", document);
  const before = JSON.parse(await readFile(file, "utf8"));
  const withheld = ["searchBatches", "collectionItems", "snapshotProducts"].map(key => path.join(`${file}.parts`, `${before.runPartitions.refs[key]}.json`));
  for (const item of withheld) await rename(item, `${item}.held`);
  try {
    assert.equal((await store.getAmazonCollectionJob("control")).status, "running");
    assert.equal((await store.getSupplierPipelineStatus("control")).status, "paused");
    await store.updateAmazonCollectionJob("control", job => { job.status = "paused"; job.revision++; });
    const after = JSON.parse(await readFile(file, "utf8"));
    for (const key of ["searchBatches", "collectionItems", "snapshotProducts", "snapshotMetadata"]) {
      assert.equal(after.runPartitions.refs[key], before.runPartitions.refs[key]);
    }
  } finally { for (const item of withheld) await rename(`${item}.held`, item); }
  const snapshot = await store.getRunSnapshot("control");
  assert.equal(snapshot.products[0].currentPrice, 12);
  assert.equal(snapshot.products[0].purchaseCost, 18);
  assert.equal(snapshot.runState.amazonCollectionJob.status, "paused");
});

test("failed manifest commit keeps old revision, all manual inputs and previous chunks readable", async () => {
  const { store, file, document } = await seeded("atomic");
  await store.writeRunFile("atomic", document);
  const bytes = await readFile(file, "utf8");
  const next = await readPartitionedRun(file, { sections: "all" });
  next.amazonCollection.job.status = "paused";
  next.snapshot.products[0].purchaseCost = 99;
  await assert.rejects(writePartitionedRun(file, next, { commit: async () => { throw new Error("simulated disk failure"); } }), /simulated disk failure/);
  assert.equal(await readFile(file, "utf8"), bytes);
  const retained = await readPartitionedRun(file, { sections: "all" });
  assert.equal(retained.amazonCollection.job.status, "running");
  assert.deepEqual(retained.snapshot.products, document.snapshot.products);
});

test("missing and corrupted referenced chunks fail closed instead of creating empty runs", async () => {
  const { store, file, document } = await seeded("integrity");
  await store.writeRunFile("integrity", document);
  const manifest = JSON.parse(await readFile(file, "utf8"));
  const chunk = path.join(`${file}.parts`, `${manifest.runPartitions.refs.collectionJob}.json`);
  const original = await readFile(chunk, "utf8");
  await writeFile(chunk, "{}");
  await assert.rejects(store.getAmazonCollectionJob("integrity"), { code: "RUN_READ_FAILED" });
  await rename(chunk, `${chunk}.held`);
  await assert.rejects(store.getAmazonCollectionJob("integrity"), { code: "RUN_READ_FAILED" });
  await rename(`${chunk}.held`, chunk);
  await writeFile(chunk, original);
});

test("export is self-contained, complete and leaves manifest unchanged", async () => {
  const { store, file, document } = await seeded("export");
  await store.writeRunFile("export", document);
  const bytes = await readFile(file, "utf8");
  const exported = JSON.parse(await readFile(await store.getRunArtifactPath("export"), "utf8"));
  assert.deepEqual(exported, JSON.parse(JSON.stringify(document)));
  assert.equal(exported.runPartitions, undefined);
  assert.equal(await readFile(file, "utf8"), bytes);
});

test("unchanged control and rejected revision are read-only; committed chunks remain bounded", async () => {
  const { store, file, document } = await seeded("bounded");
  await store.writeRunFile("bounded", document);
  const before = await readFile(file, "utf8");
  await store.updateAmazonCollectionJob("bounded", job => job);
  await assert.rejects(store.updateAmazonCollectionJob("bounded", job => ({ ...job, revision: 0 })), { code: "STALE_COLLECTION_UPDATE" });
  assert.equal(await readFile(file, "utf8"), before);
  for (let index = 0; index < 15; index++) await store.updateAmazonCollectionJob("bounded", job => { job.revision++; job.message = String(index); });
  const manifest = JSON.parse(await readFile(file, "utf8"));
  const chunks = (await readdir(`${file}.parts`)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(chunks.length, new Set(Object.values(manifest.runPartitions.refs)).size);
});

test("archived partitioned runs cannot be reactivated or lose historical manual values", async () => {
  const { store, document } = await seeded("archive");
  await store.writeRunFile("archive", document);
  await store.archiveRun("archive");
  const manifest = JSON.parse(await readFile(store.runPath("archive"), "utf8"));
  assert.equal(manifest.status, "cancelled");
  assert.ok(manifest.archivedAt);
  const parts = `${store.runPath("archive")}.parts`;
  await rename(parts, `${parts}.held`);
  try {
    await assert.rejects(store.setActiveSupplierRunId("archive"), { code: "RUN_ARCHIVED" });
  } finally { await rename(`${parts}.held`, parts); }
  await assert.rejects(store.updateAmazonCollectionJob("archive", job => { job.enabled = true; job.revision++; }), { code: "RUN_ARCHIVED" });
  const snapshot = await store.getRunSnapshot("archive");
  assert.deepEqual(snapshot.products, document.snapshot.products);
  assert.equal((await store.getAmazonCollectionJob("archive")).enabled, false);
  snapshot.products[0].purchaseCost = 27;
  snapshot.products[0].reviewStatus = 'approved';
  await store.saveSnapshot(snapshot);
  const restarted = new PersistenceStore({ directory: store.directory });
  const edited = await restarted.getRunSnapshot('archive');
  assert.equal(edited.products[0].purchaseCost, 27);
  assert.equal(edited.products[0].reviewStatus, 'approved');
  assert.equal(edited.runState.archivedAt, snapshot.runState.archivedAt);
  assert.equal((await restarted.getAmazonCollectionJob('archive')).enabled, false);
});


test("store checkpoint sources survive large legacy migration, overview and supplier writes", async () => {
  const { store, document, file } = await seeded("sources");
  const baseline = (await store.getRunSnapshot("sources")).amazonDiscoveredSources;
  assert.equal(baseline.length, 1);
  assert.deepEqual(baseline[0].asins, [asin]);
  await store.updateAmazonCollectionJob("sources", job => { job.status = "paused"; job.revision++; });
  assert.ok(JSON.parse(await readFile(file, "utf8")).runPartitions);
  assert.deepEqual((await store.getRunSnapshot("sources")).amazonDiscoveredSources, baseline);
  await store.setActiveSupplierRunId("sources");
  assert.deepEqual((await store.getOverview()).latestRun.amazonDiscoveredSources, baseline);
  await store.updateSupplierSnapshot("sources", snapshot => { snapshot.runState.supplier1688Pipeline.revision++; });
  assert.deepEqual((await store.getRunSnapshot("sources")).amazonDiscoveredSources, baseline);
  assert.deepEqual(await store.getAmazonStoreCheckpoints("sources"), document.amazonStoreCheckpoints);
});

test("supplier callback sees current Amazon inputs and commit recalculates changed costs without replacing those inputs", async () => {
  const { store, document } = await seeded("supplier-projection");
  const product = document.snapshot.products[0];
  product.manualAmazonFields = {};
  product.manualPurchaseCost = false;
  product.fulfillmentMode = "FBA";
  product.productWeight = 0.2;
  document.amazonCollection.items[asin] = { asin, sourceAsin: asin, marketplace: "AU", detailStatus: "success", currentPrice: 29, productWeightKg: 0.2 };
  await store.writeRunFile("supplier-projection", document);
  let priorProfit;
  const committed = await store.updateSupplierSnapshot("supplier-projection", snapshot => {
    const item = snapshot.products[0];
    assert.equal(item.currentPrice, 29, "updater receives collected facts rather than the legacy price");
    assert.ok(item.profitCalculation, "updater receives normalized pre-update profit inputs");
    priorProfit = item.profitCalculation.profit;
    item.currentPrice = 999;
    item.purchaseCost = 7;
    item.purchaseUnitCostCny = 7;
    item.manualPurchaseCost = true;
    item.profitInputs.commissionRate = 0.25;
  });
  assert.equal(committed.products[0].currentPrice, 29, "final projection preserves canonical Amazon facts");
  assert.equal(committed.products[0].purchaseCost, 7);
  assert.notEqual(committed.products[0].profitCalculation.profit, priorProfit);
  assert.deepEqual(committed.products[0].profitCalculation, recomputeProductProfit(committed.products[0], committed).profitCalculation);
});
