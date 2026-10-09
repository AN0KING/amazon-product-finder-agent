// 一次性迁移：压缩历史快照文件里膨胀的 supplierSearchAudit.rejected 明细。
// 这些文件是 2026-10-09 前持久化的，rejected 数组存了完整报价对象（单商品 ~98KB），
// 1176 个商品令快照膨胀到 199MB，加载/保存时触发 OOM。
// 本脚本复用与 persistence-store.mjs 相同的裁剪规则，只瘦身 supplierSearchAudit，
// 其余数据原样保留（不动历史任务的产品/利润/状态）。
import { readdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const dataDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve("data/runs");

const THRESHOLD_BYTES = 2 * 1024 * 1024; // 只处理 >2MB 的快照文件

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactSupplierSearchAudit(audit) {
  if (!isPlainObject(audit)) return audit;
  const compacted = {};
  for (const key of [
    "target", "rawCandidateCount", "similarity", "groups", "selectionMode",
    "costConfidence", "procurementTaskId", "procurementTaskStatus", "procurementTaskReused",
    "imageCandidatesReturned", "imageCandidatesCompared", "imageQualifiedUniqueCount",
    "mergedQualifiedUniqueCount", "finalFallbackEligibleUniqueCount", "finalMergedCandidateCount",
    "searchAttempts", "searchStrategyVersion", "sharedContext", "onlineAuthRequired",
  ]) {
    if (key in audit) compacted[key] = audit[key];
  }
  if (isPlainObject(audit.rejected) && audit.rejected.summary === true) {
    compacted.rejected = audit.rejected;
  } else {
    const rejected = Array.isArray(audit.rejected) ? audit.rejected : [];
    const reasons = {};
    for (const quote of rejected) {
      if (!isPlainObject(quote)) continue;
      const reason = String(quote.excludedReason || "unspecified").slice(0, 80) || "unspecified";
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
    compacted.rejected = { summary: true, count: rejected.length, reasons };
  }
  const accepted = Array.isArray(audit.accepted) ? audit.accepted : [];
  compacted.accepted = accepted.slice(0, 200).map((quote) => isPlainObject(quote)
    ? {
        supplierId: quote.supplierId ?? null,
        offerId: quote.offerId ?? null,
        rank: Number.isFinite(Number(quote.rank)) ? Number(quote.rank) : null,
        unitPriceCny: Number.isFinite(Number(quote.unitPriceCny)) ? Number(quote.unitPriceCny) : null,
      }
    : null).filter(Boolean);
  return compacted;
}

function compactProduct(product) {
  if (!isPlainObject(product)) return product;
  const audit = product.supplierSearchAudit;
  if (!isPlainObject(audit)) return product;
  return { ...product, supplierSearchAudit: compactSupplierSearchAudit(audit) };
}

async function main() {
  const files = (await readdir(dataDir)).filter((f) => f.endsWith(".json"));
  let changed = 0;
  let skipped = 0;
  let failed = 0;
  for (const file of files) {
    const filePath = path.join(dataDir, file);
    const info = await stat(filePath).catch(() => null);
    if (!info || info.size <= THRESHOLD_BYTES) { skipped += 1; continue; }
    const raw = await readFile(filePath, "utf8");
    let document;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      console.error(`✗ 解析失败 ${file}: ${error.message}`);
      failed += 1;
      continue;
    }
    const products = document?.snapshot?.products;
    if (!Array.isArray(products)) { skipped += 1; continue; }
    let compactedCount = 0;
    const beforeBytes = Buffer.byteLength(raw, "utf8");
    const newProducts = products.map((product) => {
      if (isPlainObject(product?.supplierSearchAudit)) compactedCount += 1;
      return compactProduct(product);
    });
    if (compactedCount === 0) { skipped += 1; continue; }
    document.snapshot.products = newProducts;
    // 原子写：临时文件 + rename，避免中断损坏原文件。
    const tmp = `${filePath}.compact-${process.pid}-${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(tmp, filePath);
    const afterBytes = (await stat(filePath)).size;
    const runId = document.id || file.slice(0, 8);
    console.log(`✓ ${runId.slice(0, 12)}  ${(beforeBytes / 1024 / 1024).toFixed(1)}MB → ${(afterBytes / 1024 / 1024).toFixed(1)}MB  (压缩 ${compactedCount} 个商品的 supplierSearchAudit)`);
    changed += 1;
  }
  console.log(`\n完成：处理 ${changed} 个文件，跳过 ${skipped} 个（<2MB 或无 audit），失败 ${failed} 个。`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
