import { amazonMonthlySalesValue } from "./lib/amazon-sales-policy.mjs";
import "./lib/fetch-proxy.mjs";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeHTML } from "entities";
import {
  callSellerSpriteTool,
  classifySellerSpriteConnectionError,
  connectSellerSprite,
  getConnectionSummary,
  resetSellerSpriteClient,
} from "./lib/sellsprite-client.mjs";
import {
  AMAZON_PRODUCT_DETAIL_PARSER_VERSION,
  AmazonStoreError,
  buildSellerUrl,
  createAmazonStoreSession,
  normalizeAmazonProductUrl,
} from "./lib/amazon-store-client.mjs";
import { checkAmazonConnection } from "./lib/amazon-connection-check.mjs";
import { AmazonCollectionRunner } from "./lib/amazon-collection-runner.mjs";
import { SupplierPipelineRunner } from "./lib/supplier-pipeline-runner.mjs";
import { applySupplierProfitResult } from "./lib/supplier-profit-result.mjs";
import { recomputeProductProfit } from "./lib/product-profit-state.mjs";
import { auditAmazonProductFields } from "./lib/amazon-detail-quality.mjs";
import {
  MAX_STORE_FILE_BYTES,
  StoreListError,
  parseStoreListBuffer,
} from "./lib/store-list.mjs";
import {
  PersistenceStoreError,
  persistenceStore,
  normalizeAmazonStoreCoverage,
} from "./lib/persistence-store.mjs";
import {
  Procurement1688Client,
  Procurement1688Error,
} from "./lib/1688-procurement-client.mjs";
import {
  calculateTopSixSupplierCost,
  calculateTrimmedSupplierCost,
  compareSupplierImageSimilarity,
  FALLBACK_SUPPLIER_COUNT,
  isLowConfidenceFallbackQuote,
  isSupplierMatchQualifiedQuote,
  SUPPLIER_COST_MODE_FALLBACK,
  SUPPLIER_COST_MODE_VERIFIED,
  SUPPLIER_COST_RULE_VERSION,
  SUPPLIER_IMAGE_SIMILARITY_THRESHOLD,
} from "./lib/1688-supplier-policy.mjs";
import {
  revealRunArtifact,
  RunFolderOpenError,
} from "./lib/run-folder-opener.mjs";
import {
  createEmbeddedImageWorkbook,
  validateWorkbookInput,
  XlsxExportError,
} from "./lib/xlsx-export.mjs";
import {
  ExportFileStoreError,
  normalizeExportFileName,
  saveExportWorkbook,
  saveExportHandoff,
} from "./lib/export-file-store.mjs";
import { createAnalysisHandoffPackage } from "./lib/analysis-handoff.mjs";
import {
  ensure1688Dependency,
  get1688DependencyStatus,
  ProcurementDependencyError,
} from "./scripts/start-1688-dependency.mjs";

const HOST = "127.0.0.1";
const PORT = parsePort(process.env.SCOUT_PORT || "4173");
const ORIGIN = `http://${HOST}:${PORT}`;
const APP_VERSION = "0.9.50";
const EXPECTED_HOST = `${HOST}:${PORT}`;
const ROOT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const JSON_BODY_LIMIT = 256 * 1024;
const RUN_SNAPSHOT_BODY_LIMIT = 128 * 1024 * 1024;
const MAX_STORES_PER_SEARCH = 20;
const MAX_CANDIDATES_PER_STORE = 500;
const MAX_STORE_PAGES = 25;
const MAX_STORE_ASINS = 10_000;
const MAX_DETAIL_ASINS_PER_SEARCH = MAX_STORES_PER_SEARCH * MAX_STORE_ASINS;
const SEARCH_CONCURRENCY = 1;
const SELLERSPRITE_RATE_LIMIT_RETRY_DELAY_MS = 61_000;
const MAX_ASIN_DETAIL_CACHE_ENTRIES = 5_000;
const ASIN_DETAIL_CACHE_TTL_MS = 30 * 60_000;
const COMPETITOR_LOOKUP_BATCH_SIZE = 40;
const COMPETITOR_LOOKUP_MONTH = "nearly";
const COMPETITOR_LOOKUP_MARKETPLACES = new Set(["US", "JP", "UK", "DE", "FR", "IT", "ES", "CA", "IN"]);
const COMPETITOR_LOOKUP_RETURN_FIELDS = [
  "asin", "parent", "title", "imageUrl", "units", "revenue", "amzUnit", "amzSales", "amzUnitDate",
  "price", "primePrice", "deliveryPrice", "fba", "fulfillment", "ratings", "rating", "ratingsRate",
  "ratingsCv", "ratingDelta", "availableDate", "weight", "dimension", "dimensionsType", "pkgDimensions",
  "pkgDimensionType", "pkgWeight", "badge",
].join(",");
const SUPPORTED_MARKETPLACES = new Set(["AU", "US", "NL", "CA", "UK", "DE", "FR", "IT", "ES", "PL", "MX", "BR"]);
const TERMINAL_AMAZON_PAGINATION_CODES = new Set([
  "AMAZON_PAGINATION_NO_PROGRESS",
  "AMAZON_PAGINATION_LOOP",
  "AMAZON_STORE_TOTAL_PAGE_LIMIT_REACHED",
]);
const sellerSpriteSemaphore = createSemaphore(SEARCH_CONCURRENCY);
const supplier1688Semaphore = createSemaphore(1);
const asinDetailRequestsByRun = new Map();
const supplier1688Client = new Procurement1688Client();

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/lib/amazon-sales-policy.mjs", { file: "lib/amazon-sales-policy.mjs", type: "text/javascript; charset=utf-8" }],
  ["/lib/profit-model.mjs", { file: "lib/profit-model.mjs", type: "text/javascript; charset=utf-8" }],
  ["/lib/analysis-handoff.mjs", { file: "lib/analysis-handoff.mjs", type: "text/javascript; charset=utf-8" }],
  ["/lib/analysis-coverage.mjs", { file: "lib/analysis-coverage.mjs", type: "text/javascript; charset=utf-8" }],
  ["/lib/amazon-price-state.mjs", { file: "lib/amazon-price-state.mjs", type: "text/javascript; charset=utf-8" }],
  ["/lib/amazon-detail-retry.mjs", { file: "lib/amazon-detail-retry.mjs", type: "text/javascript; charset=utf-8" }],
  ["/lib/title-piece-count.mjs", { file: "lib/title-piece-count.mjs", type: "text/javascript; charset=utf-8" }],
  ["/vendor/lucide.min.js", { file: "node_modules/lucide/dist/umd/lucide.min.js", type: "text/javascript; charset=utf-8" }],
]);

const ALLOWED_FILTERS = new Set([
  "monthlySalesBand",
  "minRating",
  "minReviews",
]);

const NUMERIC_FILTERS = new Set([
  "minRating",
  "minReviews",
]);

// 采集保留全部已发现商品；只有当前 ASIN 具备 Amazon 50+ 月购买量证据才进入候选。
const MONTHLY_SALES_FILTER_BANDS = new Set(["all", "50_to_100", "100_plus"]);

class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class ProviderError extends Error {
  constructor(code = "SELLSPRITE_UPSTREAM_ERROR") {
    super("SellerSprite could not complete the query.");
    this.name = "ProviderError";
    this.code = normalizeProviderCode(code);
  }
}

let shuttingDown = false;
let activeSearchRequests = 0;
let activeAmazonRequests = 0;
let active1688Requests = 0;
let draining = false;
let drainTimer = null;
let supplier1688RecoveryPromise = null;
let archivingRunId = null;

const amazonCollector = new AmazonCollectionRunner({
  store: persistenceStore,
  seed: seedAmazonCollection,
  discover: discoverAmazonCollection,
  loadDetails: loadAmazonCollectionDetails,
  canRun: () => !archivingRunId && !draining && !shuttingDown && activeAmazonRequests === 0 && active1688Requests === 0 && !supplierPipeline.isRunnable(),
  onBusy: (busy) => {
    activeSearchRequests = Math.max(0, activeSearchRequests + (busy ? 1 : -1));
    activeAmazonRequests = Math.max(0, activeAmazonRequests + (busy ? 1 : -1));
  },
});
let collectorReady = Promise.resolve();
const supplierPipeline = new SupplierPipelineRunner({
  store: {
    readSnapshot: (runId) => persistenceStore.getRunSnapshot(runId),
    updateSnapshot: (runId, updater) => persistenceStore.updateSupplierSnapshot(runId, updater),
    getActiveRunId: () => persistenceStore.getActiveSupplierRunId(),
    setActiveRunId: (runId) => persistenceStore.setActiveSupplierRunId(runId),
  },
  getRuntime: () => supplier1688Client.getRuntime({ verify: false }),
  canRun: () => !archivingRunId && !draining && !shuttingDown && active1688Requests === 0 && activeAmazonRequests === 0,
  onBusy: (busy) => {
    active1688Requests = Math.max(0, active1688Requests + (busy ? 1 : -1));
    activeSearchRequests = Math.max(0, activeSearchRequests + (busy ? 1 : -1));
  },
  search: async (product, snapshot, { signal, onTask }) => {
    const prepared = recomputeProductProfit(product, snapshot);
    const input = validate1688ImageSearchInput({
      runId: snapshot.runState.id, productId: product.id, asin: product.asin || product.sourceAsin,
      imageUrl: product.imageUrl, existingTaskId: product.supplierProcurementTaskId || null,
      targetCostCny: prepared.targetCostCny, moq: product.moq > 0 ? product.moq : 100,
      pieceCount: prepared.pieceCount, currentPrice: prepared.currentPrice, salePrice: prepared.salePrice,
      currency: product.currency || snapshot.runState.currency, marketplace: product.marketplace || snapshot.runState.marketplace,
    });
    const search = await supplier1688Semaphore.run(() => search1688ByImage(input, { signal, onTask }), { signal });
    return finalize1688SearchResult(search, input);
  },
  applyResult: applySupplierProfitResult,
});
let supplierPipelineReady = Promise.resolve();

const server = createServer(async (request, response) => {
  const requestController = new AbortController();
  const abortRequest = () => {
    if (!requestController.signal.aborted) requestController.abort(new Error("Local client disconnected."));
  };
  request.once("aborted", abortRequest);
  response.once("close", () => {
    if (!response.writableEnded) abortRequest();
  });
  try {
    enforceLocalRequest(request);
    const url = new URL(request.url || "/", ORIGIN);
    await routeRequest(request, response, url, requestController.signal);
  } catch (error) {
    if (requestController.signal.aborted && (request.aborted || response.destroyed)) return;
    const normalized = normalizeHttpError(error);
    if (!response.headersSent) {
      const payload = {
        ok: false,
        error: { code: normalized.code, message: normalized.message },
      };
      if (normalized.details) payload.error.details = normalized.details;
      if (String(request.url || "").split("?", 1)[0] === "/api/sellsprite/search") {
        payload.data = {
          toolCallCount: getConnectionSummary().toolCallCount,
          runToolCallCount: request.scoutRunId ? persistenceStore.getRunToolCalls(request.scoutRunId).total : 0,
        };
      }
      sendJson(response, normalized.status, payload);
    } else {
      response.destroy();
    }
  }
});

server.headersTimeout = 15_000;
server.requestTimeout = 35 * 60_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});
server.on("error", (error) => {
  process.stderr.write(`Scout Amazon server failed: ${error.code || "SERVER_ERROR"}\n`);
  process.exitCode = 1;
});

const IS_DIRECT_RUN = Boolean(
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);
if (IS_DIRECT_RUN) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`Scout Amazon local server: ${ORIGIN}\n`);
    collectorReady = amazonCollector.initialize().catch(error => {
      process.stderr.write(`Amazon collection recovery failed: ${error.code || error.message}\n`);
      throw error;
    });
    collectorReady.catch(() => {});
    supplierPipelineReady = supplierPipeline.initialize();
    supplierPipelineReady.catch(error => process.stderr.write(`Supplier pipeline recovery failed: ${error.code || error.message}\n`));
  });
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function routeRequest(request, response, url, signal) {
  const runtimeVerifyRequest = isRuntimeVerifyRequest(url);
  if (archivingRunId && request.method === "POST" && [
    "/api/amazon/collection/start", "/api/amazon/collection/control", "/api/1688/pipeline/control",
    "/api/products/search", "/api/sellsprite/search", "/api/1688/image-search", "/api/amazon/check",
  ].includes(url.pathname)) {
    throw new HttpError(409, "RUN_REPLACEMENT_PENDING", "旧任务正在取消并归档，请稍后开始新任务。");
  }
  if (STATIC_FILES.has(url.pathname)) {
    const staticVersionQuery = url.searchParams.getAll("v").length === 1
      && [...url.searchParams.keys()].every((key) => key === "v");
    if (url.search && !staticVersionQuery) {
      throw new HttpError(400, "QUERY_NOT_ALLOWED", "Only a static asset version parameter is accepted here.");
    }
    requireMethod(request, ["GET", "HEAD"]);
    await serveStatic(response, request.method, STATIC_FILES.get(url.pathname));
    return;
  }
  if (url.search && !runtimeVerifyRequest) {
    throw new HttpError(400, "QUERY_NOT_ALLOWED", "Query parameters are not accepted by this endpoint.");
  }

  if (url.pathname === "/api/events") {
    requireMethod(request, ["GET"]);
    response.writeHead(200, { ...securityHeaders(), "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    response.write(": connected\n\n");
    const unsubscribe = persistenceStore.onSnapshotUpdated((event) => {
      if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => { if (!response.destroyed) response.write(": heartbeat\n\n"); }, 20_000);
    keepAlive.unref?.();
    response.once("close", () => { unsubscribe(); clearInterval(keepAlive); });
    return;
  }

  if (url.pathname === "/api/1688/pipeline") {
    requireMethod(request, ["GET"]);
    await supplierPipelineReady;
    sendJson(response, 200, { ok: true, data: await supplierPipeline.status() });
    return;
  }
  if (url.pathname === "/api/1688/pipeline/control") {
    requireMethod(request, ["POST"]);
    requireContentType(request, ["application/json"]);
    if (draining || shuttingDown) throw new HttpError(503, "SERVICE_DRAINING", "服务正在更新，请稍后继续。");
    const { runId, action, productIds } = await readJsonBody(request);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(runId || "")) || !["start", "resume", "pause", "discard", "append"].includes(action)) {
      throw new HttpError(422, "INVALID_SUPPLIER_CONTROL", "请指定已保存的匹配批次和有效操作。");
    }
    await supplierPipelineReady;
    const state = action === "pause" ? await supplierPipeline.pause(runId)
      : action === "discard" ? await supplierPipeline.discard(runId)
      : action === "append" ? await supplierPipeline.append(runId, productIds)
      : await supplierPipeline.start(runId, { resume: true });
    sendJson(response, 200, { ok: true, data: state });
    if (action === "start" || action === "resume") void supplierPipeline.tick().catch(error => process.stderr.write(`Supplier pipeline: ${error.code || error.message}\n`));
    return;
  }

  if (url.pathname === "/api/health") {
    requireMethod(request, ["GET"]);
    await handleHealth(response, signal);
    return;
  }
  if (url.pathname === "/api/version") {
    requireMethod(request, ["GET"]);
    const connection = getConnectionSummary();
    sendJson(response, 200, {
      ok: true,
      data: {
        version: APP_VERSION,
        activeSearchRequests,
        activeAmazonRequests,
        active1688Requests,
        draining,
        connected: connection.connected,
        toolCount: connection.toolCount,
        toolCallCount: connection.toolCallCount,
        sessionToolCallCount: connection.sessionToolCallCount,
      },
    });
    return;
  }
  if (url.pathname === "/api/state") {
    requireMethod(request, ["GET"]);
    sendJson(response, 200, { ok: true, data: await persistenceStore.getOverview() });
    return;
  }
  if (url.pathname.startsWith("/api/amazon/collection")) {
    await collectorReady;
    if (url.pathname === "/api/amazon/collection") {
      requireMethod(request, ["GET"]);
      sendJson(response, 200, { ok: true, data: await amazonCollector.status() });
      return;
    }
    requireMethod(request, ["POST"]);
    requireContentType(request, ["application/json"]);
    if (draining || shuttingDown) throw new HttpError(503, "SERVICE_DRAINING", "本地服务正在重启，请稍后继续。");
    const body = await readJsonBody(request);
    const allowed = url.pathname === "/api/amazon/collection/start" ? ["runId"] : ["runId", "action", "asins"];
    if (!isPlainObject(body) || Object.keys(body).some(key => !allowed.includes(key))
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(body.runId || ""))) {
      throw new HttpError(422, "INVALID_COLLECTION_REQUEST", "后台采集请求格式无效。");
    }
    if (Object.hasOwn(body, "asins") && (body.action !== "retry_missing" || !Array.isArray(body.asins)
      || !body.asins.length || body.asins.length > 100
      || body.asins.some(asin => typeof asin !== "string" || !/^[A-Z0-9]{10}$/i.test(asin)))) {
      throw new HttpError(422, "INVALID_COLLECTION_ASINS", "指定补采仅支持 1 至 100 个有效 ASIN。");
    }
    let job;
    try {
      if (url.pathname === "/api/amazon/collection/start") {
        if (activeAmazonRequests > 0 && !(await amazonCollector.status())?.workerActive) {
          throw new HttpError(409, "TASK_IN_PROGRESS", "当前页面仍有采集请求，请等待本批保存后继续。");
        }
        job = await amazonCollector.start(body.runId);
      } else if (url.pathname === "/api/amazon/collection/control") {
        job = await amazonCollector.command(body.runId, body.action, { asins: body.asins });
      } else throw new HttpError(404, "NOT_FOUND", "采集接口不存在。");
    } catch (error) {
      throw new HttpError(error.status || 500, error.code || "COLLECTION_FAILED", error.message);
    }
    sendJson(response, 202, { ok: true, data: job });
    void amazonCollector.tick().catch(error => process.stderr.write(`Amazon collection: ${error.message}\n`));
    return;
  }
  if (url.pathname === "/api/runs") {
    requireMethod(request, ["POST"]);
    requireContentType(request, ["application/json"]);
    const body = await readJsonBody(request, RUN_SNAPSHOT_BODY_LIMIT);
    sendJson(response, 200, { ok: true, data: await persistenceStore.saveSnapshot(body) });
    return;
  }
  if (url.pathname === "/api/exports/xlsx") {
    requireMethod(request, ["POST"]);
    requireContentType(request, ["application/json"]);
    if (draining) throw new HttpError(503, "SERVICE_DRAINING", "The local service is preparing to restart.");
    const body = await readJsonBody(request, RUN_SNAPSHOT_BODY_LIMIT);
    const { fileName, ...workbookInput } = isPlainObject(body) ? body : {};
    normalizeExportFileName(fileName);
    const result = await createEmbeddedImageWorkbook({ ...workbookInput, signal });
    const saved = await saveExportWorkbook({ buffer: result.buffer, fileName, directory: process.env.SCOUT_EXPORT_DIRECTORY || undefined });
    sendJson(response, 200, {
      ok: true,
      data: {
        exportDirectory: saved.directory,
        savedFileName: saved.fileName,
        savedFilePath: saved.filePath,
        imageAudit: result.imageAudit,
      },
    });
    return;
  }
  if (url.pathname === "/api/exports/analysis-handoff") {
    requireMethod(request, ["POST"]);
    requireContentType(request, ["application/json"]);
    if (draining) throw new HttpError(503, "SERVICE_DRAINING", "The local service is preparing to restart.");
    const body = await readJsonBody(request, RUN_SNAPSHOT_BODY_LIMIT);
    if (!isPlainObject(body) || !isPlainObject(body.runState) || !Array.isArray(body.products) || !body.products.length
      || !body.products.every(isPlainObject) || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(body.runState.id || ""))
      || !["AU", "US", "NL", "CA", "UK", "DE", "FR", "IT", "ES", "PL", "MX", "BR"].includes(body.runState.marketplace)) {
      throw new HttpError(422, "INVALID_ANALYSIS_HANDOFF", "人工初审交接数据格式无效。");
    }
    if (body.criteria !== undefined && !isPlainObject(body.criteria)) {
      throw new HttpError(422, "INVALID_ANALYSIS_HANDOFF", "初筛筛选条件格式无效。");
    }
    let handoff;
    try {
      handoff = createAnalysisHandoffPackage({
        runState: body.runState, products: body.products, criteria: body.criteria || {},
        createdAt: new Date().toISOString(), synthetic: body.synthetic === true,
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new HttpError(422, "INVALID_ANALYSIS_HANDOFF", "初筛商品或筛选条件格式无效。");
    }
    if (!handoff.products.length) {
      throw new HttpError(422, "NO_REVIEWED_PRODUCTS", "当前没有具备 Amazon 50+ 月购买量证据且人工初审通过的商品，未生成采购交接包。");
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
    const market = body.runState.marketplace;
    const worksheet = body.worksheet;
    const hasWorksheet = worksheet !== undefined && worksheet !== null;
    if (hasWorksheet && (!isPlainObject(worksheet) || !Array.isArray(worksheet.headers) || !Array.isArray(worksheet.rows)
      || worksheet.rows.length !== handoff.products.length
      || worksheet.headers.filter((header) => header === "商品 ID").length !== 1
      || worksheet.rows.some((row, index) => !Array.isArray(row)
        || row.length !== worksheet.headers.length
        || row[worksheet.headers.indexOf("商品 ID")] !== handoff.products[index].product_id)
      || !Array.isArray(worksheet.images) || worksheet.images.length !== worksheet.rows.length
      || !Number.isInteger(worksheet.imageColumnIndex) || worksheet.imageColumnIndex < 0
      || worksheet.imageColumnIndex >= worksheet.headers.length
      || worksheet.imageColumnIndex === worksheet.headers.indexOf("商品 ID")
      || worksheet.imageStatusColumnIndex === worksheet.headers.indexOf("商品 ID"))) {
      throw new HttpError(422, "HANDOFF_WORKBOOK_SCOPE_MISMATCH", "Excel 与交接包的商品范围不一致，未导出。");
    }
    if (hasWorksheet) validateWorkbookInput({ ...worksheet, worksheetName: worksheet.worksheetName ?? "运营确认表" });
    const directory = process.env.SCOUT_EXPORT_DIRECTORY || undefined;
    const handoffLabel = handoff.readiness.draft ? "已初审产品交接草稿" : "已初审产品交接包";
    const saved = await saveExportHandoff({ document: handoff, fileName: `Scout_${market}_${handoffLabel}_${stamp}.json`, directory });
    let workbook = null;
    let workbookError = null;
    if (worksheet && handoff.products.length) {
      try {
        const result = await createEmbeddedImageWorkbook({ ...worksheet, signal });
        const output = await saveExportWorkbook({ buffer: result.buffer, fileName: `Scout_${market}_已初审产品_${stamp}.xlsx`, directory });
        workbook = { savedFilePath: output.filePath, imageAudit: result.imageAudit };
      } catch (error) {
        workbookError = error?.message || "Excel 生成失败，JSON 交接包已保存。";
      }
    }
    sendJson(response, 200, { ok: true, data: {
      savedFilePath: saved.filePath, packageId: handoff.package_id, createdAt: handoff.created_at,
      products: handoff.products.map((product) => ({ product_id: product.product_id, revision: product.revision,
        facts_revision: product.facts_revision, screening_revision: product.screening_revision, source_version: product.source_version })),
      workbook, workbookError, manualSelection: handoff.manual_selection, readiness: handoff.readiness,
    } });
    return;
  }
  const archiveRunMatch = /^\/api\/runs\/([^/]+)\/archive$/.exec(url.pathname);
  if (archiveRunMatch) {
    requireMethod(request, ["POST"]);
    requireContentType(request, ["application/json"]);
    if (draining || shuttingDown) throw new HttpError(503, "SERVICE_DRAINING", "服务正在更新，请稍后重新上传。");
    const body = await readJsonBody(request);
    if (!isPlainObject(body) || body.reason !== "file_upload" || Object.keys(body).some(key => key !== "reason")) {
      throw new HttpError(422, "INVALID_RUN_ARCHIVE", "仅上传新文件时取消并归档旧任务。");
    }
    const runId = decodeRunIdSegment(archiveRunMatch[1]);
    if (archivingRunId) throw new HttpError(409, "RUN_REPLACEMENT_PENDING", "已有任务正在归档，请稍后重试。");
    archivingRunId = runId;
    try {
      await Promise.all([collectorReady, supplierPipelineReady]);
      const snapshot = await persistenceStore.getRunSnapshot(runId);
      if (!snapshot) throw new HttpError(404, "RUN_NOT_FOUND", "未找到要归档的旧任务，尚未切换文件。");
      if (!snapshot.runState.archivedAt) {
        await supplierPipeline.cancelForReplacement(runId);
        await amazonCollector.cancelForReplacement(runId);
      }
      const data = await persistenceStore.archiveRun(runId);
      for (const key of asinDetailRequestsByRun.keys()) {
        if (key.startsWith(`${runId}\u0000`)) asinDetailRequestsByRun.delete(key);
      }
      sendJson(response, 200, { ok: true, data });
    } finally {
      archivingRunId = null;
    }
    return;
  }
  const openRunFolderMatch = /^\/api\/runs\/([^/]+)\/open-folder$/.exec(url.pathname);
  if (openRunFolderMatch) {
    requireMethod(request, ["POST"]);
    const runId = decodeRunIdSegment(openRunFolderMatch[1]);
    const artifactPath = await persistenceStore.getRunArtifactPath(runId);
    await revealRunArtifact(artifactPath);
    sendJson(response, 200, { ok: true, data: { opened: true, runId } });
    return;
  }
  if (url.pathname.startsWith("/api/runs/")) {
    requireMethod(request, ["GET"]);
    const runId = decodeRunIdSegment(url.pathname.slice("/api/runs/".length));
    const snapshot = await persistenceStore.getRunSnapshot(runId);
    if (!snapshot) throw new HttpError(404, "RUN_NOT_FOUND", "The saved run was not found.");
    sendJson(response, 200, { ok: true, data: snapshot });
    return;
  }
  if (url.pathname === "/api/1688/service") {
    requireMethod(request, ["GET"]);
    sendJson(response, 200, { ok: true, data: await get1688ServiceStatus() });
    return;
  }
  if (url.pathname === "/api/1688/service/recover") {
    requireMethod(request, ["POST"]);
    if (draining) throw new HttpError(503, "SERVICE_DRAINING", "The local service is preparing to restart.");
    const data = await recover1688Service();
    sendJson(response, 200, { ok: true, data });
    return;
  }
  if (url.pathname === "/api/v1/runtime") {
    requireMethod(request, ["GET"]);
    const data = await supplier1688Client.getRuntime({ verify: runtimeVerifyRequest, signal });
    sendJson(response, 200, { ok: true, data });
    return;
  }
  if (url.pathname === "/api/v1/auth/open-login") {
    requireMethod(request, ["POST"]);
    requireContentType(request, ["application/json"]);
    const body = await readJsonBody(request);
    const purpose = body?.purpose ?? "login";
    const taskId = body?.taskId === undefined || body?.taskId === null || body?.taskId === ""
      ? null
      : validateProcurementTaskId(body.taskId);
    if (
      !isPlainObject(body)
      || Object.keys(body).some((key) => !["restart", "purpose", "taskId"].includes(key))
      || (body.restart !== undefined && typeof body.restart !== "boolean")
      || !["login", "image_search"].includes(purpose)
      || (purpose === "image_search" && !taskId)
      || (purpose === "login" && taskId)
    ) {
      throw new HttpError(422, "INVALID_LOGIN_REQUEST", "The 1688 login request is invalid.");
    }
    const data = await supplier1688Client.openLogin({ restart: body.restart === true, purpose, taskId, signal });
    sendJson(response, 202, { ok: true, data });
    return;
  }
  if (url.pathname === "/api/v1/queue/resume") {
    requireMethod(request, ["POST"]);
    requireContentType(request, ["application/json"]);
    if (draining) throw new HttpError(503, "SERVICE_DRAINING", "本地服务正在重启，请稍后继续。");
    const body = await readJsonBody(request);
    if (!isPlainObject(body) || body.confirmed !== true || Object.keys(body).some(key => key !== "confirmed")) {
      throw new HttpError(422, "INVALID_QUEUE_RESUME", "请在完成图片验证后明确恢复搜图队列。");
    }
    sendJson(response, 200, { ok: true, data: await supplier1688Client.resumeQueue({ signal }) });
    return;
  }
  if (url.pathname === "/api/1688/session") {
    requireMethod(request, ["GET"]);
    sendJson(response, 200, { ok: true, data: await supplier1688Client.getRuntime({ verify: false, signal }) });
    return;
  }
  if (url.pathname === "/api/1688/session/start") {
    requireMethod(request, ["POST"]);
    sendJson(response, 202, { ok: true, data: await supplier1688Client.openLogin({ signal }) });
    return;
  }
  if (url.pathname === "/api/1688/session/check") {
    requireMethod(request, ["POST"]);
    sendJson(response, 200, { ok: true, data: await supplier1688Client.getRuntime({ verify: true, signal }) });
    return;
  }
  if (url.pathname === "/api/1688/image-search") {
    requireMethod(request, ["POST"]);
    requireContentType(request, ["application/json"]);
    if (draining) throw new HttpError(503, "SERVICE_DRAINING", "The local service is preparing to restart.");
    const pipeline = await supplierPipeline.status();
    if (pipeline && ["queued", "running", "cooldown"].includes(pipeline.status)) throw new HttpError(409, "SUPPLIER_PIPELINE_BUSY", "后台已在继续原批次，请等待当前匹配或先暂停，避免重复搜图。");
    activeSearchRequests += 1;
    active1688Requests += 1;
    try {
      await handle1688ImageSearch(request, response, signal);
    } finally {
      active1688Requests = Math.max(0, active1688Requests - 1);
      activeSearchRequests = Math.max(0, activeSearchRequests - 1);
    }
    return;
  }
  if (url.pathname === "/api/store-list/default") {
    requireMethod(request, ["GET"]);
    await handleDefaultStoreList(response);
    return;
  }
  if (url.pathname === "/api/store-list/parse") {
    requireMethod(request, ["POST"]);
    await handleUploadedStoreList(request, response);
    return;
  }
  if (url.pathname === "/api/amazon/check") {
    requireMethod(request, ["POST"]);
    if (draining) throw new HttpError(503, "SERVICE_DRAINING", "The local service is preparing to restart.");
    if (activeAmazonRequests > 0) throw new HttpError(409, "TASK_IN_PROGRESS", "Another Amazon data request is still running.");
    activeSearchRequests += 1;
    activeAmazonRequests += 1;
    try {
      await handleAmazonConnectionCheck(request, response, signal);
    } finally {
      activeAmazonRequests = Math.max(0, activeAmazonRequests - 1);
      activeSearchRequests = Math.max(0, activeSearchRequests - 1);
    }
    return;
  }
  if (url.pathname === "/api/products/search" || url.pathname === "/api/sellsprite/search") {
    requireMethod(request, ["POST"]);
    if (draining) throw new HttpError(503, "SERVICE_DRAINING", "The local service is preparing to restart.");
    if (activeAmazonRequests > 0) throw new HttpError(409, "TASK_IN_PROGRESS", "Another Amazon data request is still running.");
    activeSearchRequests += 1;
    activeAmazonRequests += 1;
    try {
      await handleProductSearch(request, response, signal);
    } finally {
      activeAmazonRequests = Math.max(0, activeAmazonRequests - 1);
      activeSearchRequests = Math.max(0, activeSearchRequests - 1);
    }
    return;
  }
  if (url.pathname === "/api/runtime/heartbeat") {
    requireMethod(request, ["POST"]);
    response.writeHead(204, securityHeaders());
    response.end();
    return;
  }
  if (url.pathname === "/api/runtime/drain") {
    requireMethod(request, ["POST"]);
    if (activeSearchRequests > 0) {
      throw new HttpError(409, "TASK_IN_PROGRESS", "A product analysis task is still running.");
    }
    draining = true;
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = setTimeout(() => {
      draining = false;
      drainTimer = null;
    }, 15_000);
    drainTimer.unref?.();
    sendJson(response, 200, { ok: true, data: { draining: true } });
    return;
  }

  throw new HttpError(404, "NOT_FOUND", "The requested local endpoint does not exist.");
}

function enforceLocalRequest(request) {
  if (request.headers.host !== EXPECTED_HOST) {
    throw new HttpError(403, "INVALID_HOST", "The Host header is not allowed.");
  }
  const origin = request.headers.origin;
  if (request.method === "POST" && origin !== ORIGIN) {
    throw new HttpError(403, "INVALID_ORIGIN", "POST requests require the exact local Origin header.");
  }
  if (request.method !== "POST" && origin !== undefined && origin !== ORIGIN) {
    throw new HttpError(403, "INVALID_ORIGIN", "The Origin header is not allowed.");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  // GET/HEAD are read-only and responses carry no CORS headers, so cross-site
  // reads cannot leak data. State-changing methods (POST etc.) stay guarded by
  // the exact-Origin rule above, so only reject cross-site non-safe methods.
  const isSafeMethod = request.method === "GET" || request.method === "HEAD";
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none" && !isSafeMethod) {
    throw new HttpError(403, "CROSS_SITE_REQUEST", "Cross-site requests are not allowed.");
  }
}

function isRuntimeVerifyRequest(url) {
  return url.pathname === "/api/v1/runtime"
    && url.searchParams.getAll("verify").length === 1
    && url.searchParams.get("verify") === "1"
    && [...url.searchParams.keys()].every((key) => key === "verify");
}

function decodeRunIdSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "INVALID_RUN_ID", "The run ID is invalid.");
  }
}

async function serveStatic(response, method, descriptor) {
  const body = await readFile(path.join(ROOT_DIRECTORY, descriptor.file));
  response.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": descriptor.type,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(method === "HEAD" ? undefined : body);
}

async function handleHealth(response, signal) {
  try {
    const tools = await connectSellerSprite({ timeout: 20_000 });
    if (signal?.aborted) return;
    const names = tools.map((tool) => tool.name).filter((name) => typeof name === "string").sort();
    sendJson(response, 200, {
      ok: true,
      data: {
        status: "live",
        version: APP_VERSION,
        toolCount: names.length,
        tools: names,
        toolCallCount: getConnectionSummary().toolCallCount,
      },
    });
  } catch (error) {
    await resetSellerSpriteClient();
    if (signal?.aborted) return;
    const failure = classifySellerSpriteConnectionError(error);
    process.stderr.write(`SellerSprite health check failed: ${safeErrorCode(error)}\n`);
    sendJson(response, 503, {
      ok: false,
      error: failure,
      data: { status: "error", version: APP_VERSION, toolCallCount: getConnectionSummary().toolCallCount },
    });
  }
}

async function get1688ServiceStatus() {
  const status = await get1688DependencyStatus();
  const messages = {
    ready: "1688 采购助手已启动",
    down: "1688 采购助手未启动",
    foreign: "本机 16880 端口被其他程序或不兼容版本占用",
  };
  return {
    status,
    ready: status === "ready",
    message: messages[status] || messages.down,
  };
}

async function recover1688Service() {
  if (supplier1688RecoveryPromise) return supplier1688RecoveryPromise;
  const pending = ensure1688Dependency()
    .then(async (result) => ({
      ...await get1688ServiceStatus(),
      alreadyRunning: result.alreadyRunning === true,
    }))
    .finally(() => {
      if (supplier1688RecoveryPromise === pending) supplier1688RecoveryPromise = null;
    });
  supplier1688RecoveryPromise = pending;
  return pending;
}

function safeErrorCode(error) {
  const code = String(error?.code || error?.name || "UNKNOWN_ERROR").toUpperCase();
  return /^[A-Z0-9_-]{1,80}$/.test(code) ? code : "UNKNOWN_ERROR";
}

async function handle1688ImageSearch(request, response, signal) {
  const input = validate1688ImageSearchInput(await readJsonBody(request));
  const search = await supplier1688Semaphore.run(
    () => search1688ByImage(input, { client: supplier1688Client, signal }),
    { signal },
  );
  sendJson(response, 200, {
    ok: true,
    data: finalize1688SearchResult(search, input),
  });
}

export async function search1688ByImage(input, { client = supplier1688Client, signal, onTask } = {}) {
  return client.searchByImage({
    imageUrl: input.imageUrl,
    existingTaskId: input.existingTaskId,
    targetMoq: input.moq,
    targetUnit: "件",
    sellingPrice: input.salePrice,
    sellingPriceCurrency: input.currency,
    destination: `Amazon ${input.marketplace} 商品成本估算`,
    signal,
    onTask,
  });
}

export function finalize1688SearchResult(search, input) {
  const searchQuotes = Array.isArray(search?.quotes) ? search.quotes : [];
  const rejectedQuotes = Array.isArray(search?.rejectedQuotes) ? search.rejectedQuotes : [];
  const allKnownQuotes = [...searchQuotes, ...rejectedQuotes];
  const qualifiedQuotes = searchQuotes.filter(isSupplierMatchQualifiedQuote);
  const expectedStrictQuotes = selectTopUniqueSupplierQuotes(allKnownQuotes, isSupplierMatchQualifiedQuote, 10);
  const ruleVerified = search?.ruleVersion === SUPPLIER_COST_RULE_VERSION
    && Number(search?.similarity?.threshold) === SUPPLIER_IMAGE_SIMILARITY_THRESHOLD
    && search?.similarity?.operator === "gt";
  const strictVerified = ruleVerified
    && search.status === "complete"
    && search.selectionMode === SUPPLIER_COST_MODE_VERIFIED
    && search.costConfidence === "high"
    && searchQuotes.length === 10
    && qualifiedQuotes.length === 10
    && sameSupplierSelection(searchQuotes, expectedStrictQuotes);
  const fallbackQuotes = searchQuotes.filter(isLowConfidenceFallbackQuote);
  const expectedFallbackQuotes = selectTopUniqueSupplierQuotes(allKnownQuotes, isLowConfidenceFallbackQuote, FALLBACK_SUPPLIER_COUNT);
  const fallbackVerified = ruleVerified
    && search.status === "fallback_estimate"
    && search.selectionMode === SUPPLIER_COST_MODE_FALLBACK
    && search.costConfidence === "low"
    && searchQuotes.length === FALLBACK_SUPPLIER_COUNT
    && fallbackQuotes.length === FALLBACK_SUPPLIER_COUNT
    && new Set(fallbackQuotes.map((quote) => quote.supplierId)).size === FALLBACK_SUPPLIER_COUNT
    && sameSupplierSelection(searchQuotes, expectedFallbackQuotes)
    && fallbackQuotes.every((quote) => quote.included === true
      && quote.costSelectionDecision === "included_low_confidence"
      && quote.excludedReason === "included_top_six_fallback");
  const verifiedCost = strictVerified
    ? calculateTrimmedSupplierCost(qualifiedQuotes)
    : fallbackVerified ? calculateTopSixSupplierCost(fallbackQuotes) : null;
  const averageCostCny = verifiedCost?.status === "complete"
    ? verifiedCost.averageCostCny
    : null;
  const purchaseCostCny = averageCostCny === null
    ? null
    : roundMoney(averageCostCny * input.pieceCount);
  const hasTargetCost = Number.isFinite(input.targetCostCny) && input.targetCostCny > 0;
  const thresholdCostCny = hasTargetCost ? roundMoney(input.targetCostCny * 0.85) : null;
  const profitable = purchaseCostCny === null || thresholdCostCny === null ? null : purchaseCostCny <= thresholdCostCny;
  const roughMargin = purchaseCostCny === null || !hasTargetCost
    ? null
    : ((input.targetCostCny - purchaseCostCny) / input.targetCostCny) * 100;
  const unverifiedStatus = ["similarity_insufficient", "insufficient"].includes(search?.status)
    ? search.status
    : "similarity_unverified";
  return {
    ...search,
    status: strictVerified ? "complete" : fallbackVerified ? "fallback_estimate" : unverifiedStatus,
    selectionMode: strictVerified
      ? SUPPLIER_COST_MODE_VERIFIED
      : fallbackVerified ? SUPPLIER_COST_MODE_FALLBACK : null,
    costConfidence: strictVerified ? "high" : fallbackVerified ? "low" : null,
    quotes: verifiedCost?.quotes || searchQuotes,
    averageCostCny,
    includedCount: verifiedCost?.includedCount || 0,
    productId: input.productId,
    asin: input.asin,
    pieceCount: input.pieceCount,
    purchaseCostCny,
    targetCostCny: input.targetCostCny,
    thresholdCostCny,
    profitable,
    roughMargin,
  };
}

function selectTopUniqueSupplierQuotes(quotes, predicate, limit) {
  const unique = new Map();
  [...quotes]
    .filter(predicate)
    .sort(compareSupplierImageSimilarity)
    .forEach((quote) => {
      const identity = String(quote?.supplierId || quote?.name || "").trim().toLocaleLowerCase("zh-CN");
      if (identity && !unique.has(identity)) unique.set(identity, quote);
    });
  return [...unique.values()].slice(0, limit);
}

function sameSupplierSelection(actual, expected) {
  if (actual.length !== expected.length) return false;
  const selectionKey = (quote) => [
    String(quote?.supplierId || quote?.name || "").trim().toLocaleLowerCase("zh-CN"),
    String(quote?.offerId || "").trim(),
    Number(quote?.unitPriceCny),
    Number(quote?.moq ?? quote?.minimumOrder),
    String(quote?.unit || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN"),
  ].join("\u0000");
  return actual.every((quote, index) => selectionKey(quote) === selectionKey(expected[index]));
}

export function validate1688ImageSearchInput(value) {
  if (!isPlainObject(value)) throw new HttpError(422, "INVALID_1688_SEARCH", "The 1688 image-search request must be an object.");
  const allowedKeys = new Set(["runId", "productId", "asin", "imageUrl", "existingTaskId", "targetCostCny", "moq", "pieceCount", "currentPrice", "salePrice", "currency", "marketplace"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new HttpError(422, "UNKNOWN_1688_SEARCH_FIELD", `Unsupported 1688 image-search field: ${key}.`);
  }
  const runId = cleanRequiredText(value.runId, 128, "runId");
  if (!/^[A-Za-z0-9._:-]+$/.test(runId)) throw new HttpError(422, "INVALID_RUN_ID", "runId contains unsupported characters.");
  const productId = cleanRequiredText(value.productId, 240, "productId");
  if (!/^[A-Za-z0-9._:-]+$/.test(productId)) throw new HttpError(422, "INVALID_PRODUCT_ID", "productId contains unsupported characters.");
  const asin = normalizeAsin(value.asin);
  if (!asin) throw new HttpError(422, "INVALID_ASIN", "A valid ASIN is required for 1688 image search.");
  const imageUrl = cleanRequiredText(value.imageUrl, 2_048, "imageUrl");
  const existingTaskId = value.existingTaskId === undefined || value.existingTaskId === null || value.existingTaskId === ""
    ? null
    : validateProcurementTaskId(value.existingTaskId);
  const targetCostCny = value.targetCostCny === null || value.targetCostCny === undefined || value.targetCostCny === ""
    ? null
    : Number(value.targetCostCny);
  if (targetCostCny !== null && (!Number.isFinite(targetCostCny) || targetCostCny <= 0 || targetCostCny > 10_000_000)) {
    throw new HttpError(422, "INVALID_TARGET_COST", "targetCostCny must be empty or greater than 0 and within the supported range.");
  }
  const moq = Number(value.moq);
  if (!Number.isFinite(moq) || moq <= 0 || moq > 1_000_000) {
    throw new HttpError(422, "INVALID_MOQ", "moq must be greater than 0 and within the supported range.");
  }
  const pieceCount = value.pieceCount === undefined ? 1 : Number(value.pieceCount);
  if (!Number.isSafeInteger(pieceCount) || pieceCount < 1 || pieceCount > 10_000) {
    throw new HttpError(422, "INVALID_PIECE_COUNT", "pieceCount must be an integer from 1 to 10000.");
  }
  const currentPrice = value.currentPrice === null || value.currentPrice === undefined || value.currentPrice === ""
    ? null
    : Number(value.currentPrice);
  if (currentPrice !== null && (!Number.isFinite(currentPrice) || currentPrice <= 0 || currentPrice > 10_000_000)) {
    throw new HttpError(422, "INVALID_CURRENT_PRICE", "currentPrice must be empty or greater than 0 and within the supported range.");
  }
  const salePrice = value.salePrice === null || value.salePrice === undefined || value.salePrice === ""
    ? null
    : Number(value.salePrice);
  if (salePrice !== null && (!Number.isFinite(salePrice) || salePrice <= 0 || salePrice > 10_000_000)) {
    throw new HttpError(422, "INVALID_SALE_PRICE", "salePrice must be empty or greater than 0 and within the supported range.");
  }
  const currency = String(value.currency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(422, "INVALID_CURRENCY", "currency must contain exactly three letters.");
  const marketplace = validateMarketplace(value.marketplace);
  return { runId, productId, asin, imageUrl, existingTaskId, targetCostCny: targetCostCny === null ? null : roundMoney(targetCostCny), moq, pieceCount, currentPrice, salePrice, currency, marketplace };
}

async function handleDefaultStoreList(response) {
  const defaultFile = await resolveDefaultStoreFile();
  const defaultPath = defaultFile.filePath;
  let details;
  try {
    details = await stat(defaultPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new HttpError(404, "DEFAULT_STORE_FILE_NOT_FOUND", "The default store workbook was not found.");
    }
    throw new HttpError(500, "DEFAULT_STORE_FILE_UNREADABLE", "The default store workbook could not be read.");
  }
  if (!details.isFile()) throw new HttpError(422, "DEFAULT_STORE_FILE_INVALID", "The default store path is not a file.");
  if (details.size > MAX_STORE_FILE_BYTES) throw new HttpError(413, "FILE_TOO_LARGE", "The workbook exceeds the 5 MB limit.");

  let buffer;
  try {
    buffer = await readFile(defaultPath);
  } catch {
    throw new HttpError(500, "DEFAULT_STORE_FILE_UNREADABLE", "The default store workbook could not be read.");
  }
  const fileName = path.basename(defaultPath);
  const parsed = await parseStoreListBuffer(buffer, { fileName, marketplace: defaultFile.marketplace });
  sendJson(response, 200, { ok: true, data: { ...parsed, fileName } });
}

async function handleUploadedStoreList(request, response) {
  requireContentType(request, [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
  ]);
  const fileName = singleHeader(request.headers["x-file-name"]);
  if (!fileName) throw new HttpError(400, "FILE_NAME_REQUIRED", "X-File-Name is required.");
  const marketplaceHeader = singleHeader(request.headers["x-marketplace"]);
  if (!marketplaceHeader) throw new HttpError(400, "MARKETPLACE_REQUIRED", "X-Marketplace is required.");
  const marketplace = validateMarketplace(marketplaceHeader);
  const buffer = await readBody(request, MAX_STORE_FILE_BYTES);
  const parsed = await parseStoreListBuffer(buffer, { fileName, marketplace });
  sendJson(response, 200, { ok: true, data: parsed });
}

async function handleProductSearch(request, response, signal) {
  requireContentType(request, ["application/json"]);
  const body = await readJsonBody(request);
  const input = validateSearchInput(body);
  request.scoutRunId = input.runId;
  const job = await amazonCollector.status();
  if (!input.useSellerSprite && job?.runId === input.runId) {
    throw new HttpError(409, "COLLECTION_SERVER_OWNED", "该任务已由后台采集，请刷新页面查看进度。");
  }
  const responseData = await executeProductSearch(input, signal);
  sendJson(response, 200, { ok: true, data: responseData });
}

export async function executeProductSearch(input, signal) {
  const collectedAt = new Date().toISOString();
  const unresolved = [];
  const callableStores = [];

  input.stores.forEach((store, index) => {
    const entry = { ...store, storeIndex: index };
    if (entry.sellerId || entry.asins.length) callableStores.push(entry);
    else {
      unresolved.push({
        storeIndex: index,
        sellerId: null,
        sellerName: null,
        rowNumbers: entry.rowNumbers,
        code: "STORE_IDENTITY_REQUIRED",
        message: "A seller ID or ASIN is required. Seller names cannot be resolved by ASIN Detail.",
      });
    }
  });

  let amazonSession = null;
  let amazonSessionError = null;
  let responseData;
  try {
    const checkpointMap = await persistenceStore.getAmazonStoreCheckpoints(input.runId);
    const needsStoreDiscovery = input.phase !== "analyze";
    const needsAmazonProductDetails = input.phase !== "discover" && !input.useSellerSprite;
    const needsAmazonSession = callableStores.length && (
      needsAmazonProductDetails
      || needsStoreDiscovery && callableStores.some((store) => Boolean(store.sellerId))
    );
    if (needsAmazonSession) {
      try {
        amazonSession = await createAmazonStoreSession(input.marketplace, { signal });
      } catch (error) {
        throwIfAborted(signal);
        amazonSessionError = error;
      }
    }

    const discoveries = [];
    let amazonAccessPause = null;
    for (const store of callableStores) {
      throwIfAborted(signal);
      const checkpoint = amazonCheckpointForStore(checkpointMap, input.marketplace, store);
      const discovery = input.phase === "analyze"
        ? discoveryFromAmazonCheckpoint(store, checkpoint)
        : !store.sellerId
          ? await discoverStore(store, amazonSession, amazonSessionError, signal, { runId: input.runId, checkpoint })
        : amazonAccessPause
          ? await deferStoreAfterAmazonPause(store, checkpoint, input, amazonAccessPause)
          : amazonCheckpointCoolingDown(checkpoint)
            ? discoveryFromAmazonCheckpoint(store, checkpoint)
          : await discoverStore(
              store,
              amazonSession,
              amazonSessionError,
              signal,
              { runId: input.runId, checkpoint },
            );
      discoveries.push(discovery);
      if (["AMAZON_ACCESS_CHALLENGE", "AMAZON_HTTP_429"].includes(discovery.visit.code)) {
        amazonAccessPause = {
          code: discovery.visit.code,
          message: "Amazon store access is temporarily unavailable for this marketplace session.",
        };
      }
    }

    const { analysis, discoveryComplete } = await analyzeProductSearchDiscoveries(
      discoveries,
      input,
      collectedAt,
      signal,
      {
        competitorLookupLoader: loadSellerSpriteCompetitorLookup,
        amazonDetailLoader: (asin, options) => {
          if (!amazonSession) throw amazonSessionError || new AmazonStoreError("AMAZON_SESSION_FAILED", "Amazon product session is unavailable.");
          return amazonSession.getProductDetail(asin, options);
        },
      },
    );
    const baseItems = deduplicateSourceAsins(analysis.items);
    const items = selectFinalCandidatesPerStore(baseItems, input).map((item) => {
      const filterExclusionReasons = candidateFilterExclusionReasons(item, input.filters);
      return {
        ...item,
        filterMatch: filterExclusionReasons.length === 0,
        filterExclusionReasons,
      };
    });
    const storeVisits = discoveries.map((discovery, index) => ({
      ...discovery.visit,
      analysis: analysis.storeAudits[index] || emptyStoreAnalysisAudit(),
    }));
    const errors = [
      ...discoveries.flatMap((discovery) => discovery.errors),
      ...analysis.errors,
    ];
    const deferredFilters = [];
    const analysisAudit = {
      ...analysis.audit,
      wideCandidates: baseItems.length,
      parentCandidates: new Set(baseItems
        .filter((item) => item.parentResolved === true)
        .map((item) => item.parentAsin)).size,
      selectedCandidates: items.filter((item) => item.filterMatch).length,
    };
    const pendingStores = storeVisits.filter((visit) => visit.status === "pending").length;
    const waitingStores = storeVisits.filter((visit) => visit.status === "waiting").length;

    responseData = {
      runId: input.runId,
      phase: input.phase,
      marketplace: input.marketplace,
      sourceMarketplace: input.marketplace,
      providerMarketplace: input.useSellerSprite ? sellerSpriteProviderFor(input.marketplace).providerMarketplace : null,
      providerMode: input.useSellerSprite ? sellerSpriteProviderFor(input.marketplace).providerMode : null,
      analysisSourceMode: input.useSellerSprite ? "amazon_sellsprite" : "amazon_only",
      requestedStores: input.stores.length,
      processedStores: callableStores.length,
      discoveryComplete,
      pendingStores,
      waitingStores,
      items,
      errors,
      unresolved,
      storeVisits,
      visitAudit: summarizeStoreVisits(storeVisits),
      analysisAudit,
      enrichment: null,
      appliedFilters: asinDetailFilters(input.filters),
      deferredFilters,
      dataSource: input.phase === "discover"
        ? "amazon-store-checkpoint"
        : input.useSellerSprite ? "amazon-store+sellsprite-mcp" : "amazon-store+amazon-product-page",
      collectedAt,
    };
  } catch (error) {
    await persistenceStore.appendSearchBatch(input.runId, {
      collectedAt,
      marketplace: input.marketplace,
      phase: input.phase,
      status: "failed",
      productCount: 0,
      error: {
        code: normalizeProviderCode(error?.code || error?.name || "RUN_FAILED"),
        message: String(error?.message || "The analysis failed.").slice(0, 500),
      },
    }).catch(() => {});
    throw error;
  } finally {
    await amazonSession?.close();
  }

  responseData.toolCallCount = getConnectionSummary().toolCallCount;
  responseData.runToolCallCount = persistenceStore.getRunToolCalls(input.runId).total;
  await persistenceStore.appendSearchBatch(input.runId, {
    collectedAt,
    marketplace: input.marketplace,
    phase: input.phase,
    status: input.phase === "discover" || responseData.discoveryComplete !== true ? "collecting" : "completed",
    productCount: responseData.items.length,
    requestedStores: input.stores,
    filters: input.filters,
    response: responseData,
  });
  return responseData;
}

async function seedAmazonCollection(snapshot) {
  const runId = snapshot.runState.id;
  await persistenceStore.writeQueue;
  const document = await persistenceStore.readRunFile(runId);
  const marketplace = snapshot.runState.marketplace;
  const checkpoints = document?.amazonStoreCheckpoints || {};
  const discoveries = (snapshot.storeList?.stores || []).map((store, storeIndex) =>
    discoveryFromAmazonCheckpoint({ ...store, marketplace, storeIndex }, amazonCheckpointForStore(checkpoints, marketplace, store)));
  const targets = new Map(collectDiscoveredAsinTargets(discoveries).map(target => [target.asin, target]));
  for (const product of snapshot.products || []) {
    const asin = normalizeAsin(product.sourceAsin || product.asin);
    if (asin && !targets.has(asin)) targets.set(asin, {
      asin, sales30: amazonMonthlySalesValue(product),
      sales30Evidence: amazonMonthlySalesValue(product) === null ? null : product.sales30Evidence,
      sourceStores: product.sourceStores || [{ sellerId: product.sellerId }],
    });
  }
  const items = new Map();
  for (const batch of document?.searchBatches || []) {
    if (batch.marketplace !== marketplace) continue;
    for (const item of batch.response?.items || []) {
      const asin = normalizeAsin(item.sourceAsin || item.asin);
      if (asin && targets.has(asin) && item.detailStatus === 'success'
        && Number(item.detailParserVersion) >= AMAZON_PRODUCT_DETAIL_PARSER_VERSION) items.set(asin, item);
    }
  }
  return { targets: [...targets.values()], items: [...items.values()],
    discoveryComplete: discoveries.length > 0 && discoveries.every(discovery => discovery.visit.complete === true) };
}

function collectionFilters(job) {
  return Object.fromEntries([...ALLOWED_FILTERS].filter(key => job.filters?.[key] !== undefined)
    .map(key => [key, job.filters[key]]));
}

async function discoverAmazonCollection(job, signal) {
  const checkpointMap = await persistenceStore.getAmazonStoreCheckpoints(job.runId);
  const stores = job.stores.map((store, storeIndex) => ({ ...store, marketplace: job.marketplace, storeIndex }));
  const previousDiscoveries = stores.map(store => discoveryFromAmazonCheckpoint(store,
    amazonCheckpointForStore(checkpointMap, job.marketplace, store)));
  const unfinished = stores.filter(store => !discoveryFromAmazonCheckpoint(store,
    amazonCheckpointForStore(checkpointMap, job.marketplace, store)).visit.complete);
  let data = null;
  if (unfinished.length) {
    const store = unfinished[job.discoveryCursor % unfinished.length];
    const input = validateSearchInput({ runId: job.runId, marketplace: job.marketplace,
      stores: [store], useSellerSprite: false, phase: 'discover', filters: collectionFilters(job) });
    data = await executeProductSearch(input, signal);
  }
  const updated = await persistenceStore.getAmazonStoreCheckpoints(job.runId);
  const discoveries = stores.map(store => discoveryFromAmazonCheckpoint(store,
    amazonCheckpointForStore(updated, job.marketplace, store)));
  const visits = discoveries.map(discovery => discovery.visit);
  const restrictionCode = (data?.errors || []).map(error => error.code)
    .find(code => ['AMAZON_ACCESS_CHALLENGE', 'AMAZON_HTTP_429'].includes(code))
    || (data?.storeVisits || []).map(visit => visit.code)
      .find(code => ['AMAZON_ACCESS_CHALLENGE', 'AMAZON_HTTP_429'].includes(code));
  const terminal = (data?.errors || []).find(error => error.retryable === false);
  const noProgress = (data?.storeVisits || []).find(visit => TERMINAL_AMAZON_PAGINATION_CODES.has(visit.code));
  const signature = values => JSON.stringify(values.map(value => [value.asins.length,
    value.visit.pagesVisited, value.visit.complete, value.visit.nextHref]));
  return { targets: collectDiscoveredAsinTargets(discoveries), items: data?.items || [],
    complete: discoveries.length > 0 && discoveries.every(discovery => discovery.visit.complete === true),
    cursor: job.discoveryCursor + 1, storeVisits: visits, visitAudit: summarizeStoreVisits(visits),
    restrictionCode, terminalCode: terminal?.code || noProgress?.code,
    progressed: signature(previousDiscoveries) !== signature(discoveries),
    message: terminal?.message || noProgress?.message };
}

async function loadAmazonCollectionDetails(job, asins, signal) {
  const session = await createAmazonStoreSession(job.marketplace, { signal });
  try {
    const discoveries = asins.flatMap(asin => {
      const sources = job.tasks[asin]?.sourceStores || [];
      return (sources.length ? sources : [{}]).map(sourceStore => ({
        asins: [asin], sourceStore, visit: { complete: true },
        salesByAsin: { [asin]: { sales30: job.tasks[asin]?.sales30Evidence?.value, rawText: job.tasks[asin]?.sales30Evidence?.rawText } },
      }));
    });
    const result = await analyzeAmazonDiscoveredAsins(discoveries, {
      runId: job.runId, marketplace: job.marketplace, detailAsins: asins,
      detailConcurrency: 2, filters: collectionFilters(job),
    }, new Date().toISOString(), signal, { detailLoader: (asin, options) => session.getProductDetail(asin, options) });
    return result.items.map(item => {
      const reasons = candidateFilterExclusionReasons(item, collectionFilters(job));
      return { ...item, filterMatch: reasons.length === 0, filterExclusionReasons: reasons };
    });
  } finally {
    await session.close();
  }
}

async function handleAmazonConnectionCheck(request, response, signal) {
  requireContentType(request, ["application/json"]);
  const input = validateAmazonConnectionInput(await readJsonBody(request));
  const result = await checkAmazonConnection({ ...input, signal });
  const saved = await persistenceStore.saveAmazonConnectionCheck(result);
  const connection = getConnectionSummary();
  sendJson(response, 200, {
    ok: true,
    data: {
      ...saved,
      toolCallCount: connection.toolCallCount,
      sessionToolCallCount: connection.sessionToolCallCount,
    },
  });
}

function amazonCheckpointForStore(checkpoints, marketplace, store) {
  if (!store?.sellerId || !isPlainObject(checkpoints)) return null;
  return checkpoints[`${marketplace}:${store.sellerId}`] || null;
}

function amazonCheckpointCoolingDown(checkpoint) {
  return Boolean(
    checkpoint?.complete !== true
    && typeof checkpoint?.retryAt === "string"
    && Number.isFinite(Date.parse(checkpoint.retryAt))
    && Date.parse(checkpoint.retryAt) > Date.now()
  );
}

function amazonStoreCoverageFields(source, store, overrides = {}) {
  return {
    marketplace: store.marketplace,
    ...normalizeAmazonStoreCoverage({ ...(source || {}), ...overrides }, { marketplace: store.marketplace, sellerId: store.sellerId }),
  };
}

export function discoveryFromAmazonCheckpoint(store, checkpoint) {
  const sourceStore = {
    storeIndex: store.storeIndex,
    sellerId: store.sellerId,
    sellerName: store.sellerName || checkpoint?.sellerName || null,
    rowNumbers: store.rowNumbers,
  };
  const observedOnSuccessfulPages = (Array.isArray(checkpoint?.pageAudit) ? checkpoint.pageAudit : [])
    .filter(page => page?.status === "success")
    .flatMap(page => Array.isArray(page.observedAsins) ? page.observedAsins : []);
  const asins = [...new Set([...(store.asins || []), ...(checkpoint?.asins || []), ...(checkpoint?.observedAsins || []), ...observedOnSuccessfulPages]
    .map(normalizeAsin).filter(Boolean))].slice(0, MAX_STORE_ASINS);
  // 断点保留全部已观察到的 ASIN；销量证据独立校验，缺标识不阻止详情采集。
  const cardSalesSource = isPlainObject(checkpoint?.salesByAsin) ? checkpoint.salesByAsin : {};
  const salesByAsin = {};
  for (const asin of asins) {
    const entry = cardSalesSource[asin];
    if (entry && amazonMonthlySalesValue({ asin, sales30Evidence: {
      source: "amazon_store_card", asin, period: "past_month", kind: "lower_bound",
      value: entry.sales30, rawText: entry.rawText,
    } }) !== null) {
      salesByAsin[asin] = String(entry.rawText || "").trim()
        ? { sales30: entry.sales30, rawText: String(entry.rawText).trim() }
        : { sales30: entry.sales30 };
    }
  }
  const complete = checkpoint?.complete === true || (!store.sellerId && asins.length > 0);
  const status = complete
    ? asins.length ? "visited" : "empty"
    : checkpoint?.status === "waiting" ? "waiting" : "pending";
  const interruption = checkpoint?.interruption || null;
  const paginationIncomplete = !complete && Boolean(checkpoint?.nextHref) && !interruption;
  const code = interruption?.code
    || (paginationIncomplete ? "AMAZON_PAGINATION_INCOMPLETE" : null)
    || (checkpoint ? null : "AMAZON_DISCOVERY_REQUIRED");
  const message = interruption?.message
    || (paginationIncomplete ? "Amazon store pagination is waiting to continue." : null)
    || (checkpoint ? null : "Amazon store discovery has not completed yet.");
  const omissionReasons = complete
    ? completedAmazonCheckpointOmissionReasons(checkpoint, asins)
    : pendingAmazonCheckpointOmissionReasons(checkpoint, interruption, code, message);
  return {
    store,
    sourceStore,
    asins,
    salesByAsin,
    errors: [],
    visit: {
      ...sourceStore,
      ...amazonStoreCoverageFields(checkpoint, store),
      status,
      pagesVisited: Number(checkpoint?.pagesVisited || 0),
      discoveredAsins: asins.length,
      reportedTotalAsins: Number.isInteger(checkpoint?.reportedTotalAsins) ? checkpoint.reportedTotalAsins : null,
      notEnumeratedAsins: Number(checkpoint?.notEnumeratedAsins || 0),
      excludedUnder50Count: nonNegativeCountOrDefault(checkpoint?.excludedUnder50Count),
      omissionReasons: buildDiscoveryOmissionReasons(checkpoint, omissionReasons),
      truncated: checkpoint?.truncated === true || !complete,
      canonicalUrl: checkpoint?.canonicalUrl || (store.sellerId ? buildSellerUrl(store.marketplace, store.sellerId, 1) : null),
      deliveryPostalCode: checkpoint?.deliveryPostalCode || null,
      deliveryRegionReady: checkpoint?.deliveryRegionReady === true,
      deliveryRegionMode: checkpoint?.deliveryRegionMode || null,
      complete,
      nextHref: checkpoint?.nextHref || null,
      interruption,
      code,
      message,
      retryAfterMs: complete
        ? 0
        : checkpoint?.retryAt && Number.isFinite(Date.parse(checkpoint.retryAt))
          ? Math.max(0, Date.parse(checkpoint.retryAt) - Date.now())
          : retryAfterMsForAmazonCode(code),
      retryAt: complete ? null : checkpoint?.retryAt || null,
    },
  };
}

function nonNegativeCountOrDefault(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// 此计数仅解释候选筛选，不表示商品未采集；详情页仍可能提供合格的月购买量证据。
function buildDiscoveryOmissionReasons(checkpoint, reasons) {
  const excluded = nonNegativeCountOrDefault(checkpoint?.excludedUnder50Count);
  if (!excluded) return reasons;
  return [...reasons, {
    code: "AMAZON_STORE_MONTHLY_SALES_GATE",
    count: excluded,
    message: "店铺卡片暂未取得 50+ 月购买量证据的商品仍保留采集，详情完成后再按有效证据筛选候选。",
  }];
}

function pendingAmazonCheckpointOmissionReasons(checkpoint, interruption, code, message) {
  const reasons = [];
  if (checkpoint?.nextHref) {
    reasons.push({
      code: "AMAZON_PAGINATION_INCOMPLETE",
      count: Number(checkpoint?.notEnumeratedAsins) > 0 ? Number(checkpoint.notEnumeratedAsins) : null,
      message: "Amazon store pagination has more pages or is waiting to continue.",
    });
  }
  if (interruption) {
    reasons.push({
      code: interruption.code || "AMAZON_STORE_VISIT_INTERRUPTED",
      count: null,
      message: interruption.message || "Amazon store pagination was interrupted before all source ASINs were enumerated.",
    });
  }
  if (reasons.length === 0) {
    reasons.push({
      code: code || "AMAZON_DISCOVERY_PENDING",
      count: null,
      message: message || "Amazon store discovery is waiting to continue.",
    });
  }
  return reasons;
}

function completedAmazonCheckpointOmissionReasons(checkpoint, asins) {
  const interruptionCode = checkpoint?.interruption?.code || null;
  const terminalInterruption = TERMINAL_AMAZON_PAGINATION_CODES.has(interruptionCode);
  if (!checkpoint?.truncated && !terminalInterruption) return [];
  const reasons = [];
  const reportedGap = Number.isInteger(checkpoint.reportedTotalAsins)
    ? Math.max(0, checkpoint.reportedTotalAsins - asins.length)
    : 0;
  if (reportedGap > 0) {
    reasons.push({
      code: "AMAZON_REPORTED_TOTAL_GAP",
      count: reportedGap,
      message: "Amazon reported more store results than the unique source ASINs exposed by its product cards.",
    });
  }
  if (asins.length >= MAX_STORE_ASINS) {
    reasons.push({
      code: "SOURCE_ASIN_LIMIT_REACHED",
      count: null,
      message: `The combined source-ASIN list reached the ${MAX_STORE_ASINS}-item safety limit.`,
    });
  }
  if (terminalInterruption) {
    reasons.push({
      code: interruptionCode,
      count: null,
      message: checkpoint.interruption.message || "Amazon store pagination ended because it could not make forward progress.",
    });
  }
  return reasons;
}

export async function deferStoreAfterAmazonPause(store, checkpoint, input, pause, checkpointStore = persistenceStore) {
  const sourceStore = {
    storeIndex: store.storeIndex,
    sellerId: store.sellerId,
    sellerName: store.sellerName || checkpoint?.sellerName || null,
    rowNumbers: store.rowNumbers,
  };
  const { asins, salesByAsin } = discoveryFromAmazonCheckpoint(store, checkpoint);
  const retryAfterMs = retryAfterMsForAmazonCode(pause.code);
  const retryAt = new Date(Date.now() + retryAfterMs).toISOString();
  const canonicalUrl = checkpoint?.canonicalUrl || (store.sellerId ? buildSellerUrl(input.marketplace, store.sellerId, 1) : null);
  if (store.sellerId) {
    await checkpointStore.saveAmazonStoreCheckpoint(input.runId, {
      marketplace: input.marketplace,
      ...sourceStore,
      ...amazonStoreCoverageFields(checkpoint, store, { complete: false, interruption: pause }),
      asins,
      salesByAsin,
      pagesVisited: Number(checkpoint?.pagesVisited || 0),
      reportedTotalAsins: Number.isInteger(checkpoint?.reportedTotalAsins) ? checkpoint.reportedTotalAsins : null,
      notEnumeratedAsins: Number(checkpoint?.notEnumeratedAsins || 0),
      truncated: true,
      complete: false,
      nextHref: checkpoint?.nextHref || null,
      canonicalUrl,
      interruption: { code: pause.code, message: pause.message },
      status: "waiting",
      deliveryPostalCode: checkpoint?.deliveryPostalCode || null,
      deliveryRegionReady: checkpoint?.deliveryRegionReady === true,
      deliveryRegionMode: checkpoint?.deliveryRegionMode || null,
      attempt: Number(checkpoint?.attempt || 0),
      retryAt,
    });
  }
  return {
    store,
    sourceStore,
    asins,
    salesByAsin,
    errors: [],
    visit: {
      ...sourceStore,
      ...amazonStoreCoverageFields(checkpoint, store, { complete: false, interruption: pause }),
      status: "waiting",
      pagesVisited: Number(checkpoint?.pagesVisited || 0),
      discoveredAsins: asins.length,
      reportedTotalAsins: Number.isInteger(checkpoint?.reportedTotalAsins) ? checkpoint.reportedTotalAsins : null,
      notEnumeratedAsins: Number(checkpoint?.notEnumeratedAsins || 0),
      excludedUnder50Count: nonNegativeCountOrDefault(checkpoint?.excludedUnder50Count),
      omissionReasons: [{
        code: "AMAZON_QUEUE_PAUSED",
        count: null,
        message: "Amazon paused this marketplace queue after an access restriction; this store was not attempted.",
      }],
      truncated: true,
      canonicalUrl,
      complete: false,
      nextHref: checkpoint?.nextHref || null,
      interruption: { code: pause.code, message: pause.message },
      code: "AMAZON_QUEUE_PAUSED",
      message: pause.message,
      retryAfterMs,
      retryAt,
    },
  };
}

function pendingAmazonProductItem(target, input, collectedAt) {
  const item = normalizeAmazonProductItem({ asin: target.asin }, target, input, collectedAt) || {};
  Object.assign(item, {
    detailStatus: "pending",
    detailErrorCode: "AMAZON_DETAIL_PENDING",
    detailError: "Amazon product details are waiting to be collected.",
    detailRetryable: true,
    detailAttempts: 0,
    enrichmentTools: [],
    dataSource: "amazon-store-checkpoint",
    sourceTool: "amazon_store_checkpoint",
  });
  item.missingFields = collectAmazonProductMissingFields(item);
  item.collectionQuality = auditAmazonProductFields(item, { marketplace: input.marketplace, now: collectedAt });
  return item;
}

function discoveryOnlyAnalysis(discoveries, input, collectedAt) {
  const targets = collectDiscoveredAsinTargets(discoveries);
  const storeAudits = discoveries.map((discovery) => ({
    ...emptyStoreAnalysisAudit(),
    uniqueAsins: new Set(discovery.asins || []).size,
    wideCandidates: new Set(discovery.asins || []).size,
  }));
  return {
    items: targets.map((target) => pendingAmazonProductItem(target, input, collectedAt)),
    errors: [],
    storeAudits,
    audit: {
      ...emptyStoreAnalysisAudit(),
      uniqueAsins: targets.length,
      wideCandidates: targets.length,
      retainedSourceAsins: targets.length,
      ...emptyCompetitorLookupAudit(),
      rateLimitEvents: [],
    },
  };
}

export async function analyzeProductSearchDiscoveries(
  discoveries,
  input,
  collectedAt,
  signal,
  {
    sellerSpriteAnalyzer = analyzeDiscoveredAsins,
    amazonAnalyzer = analyzeAmazonDiscoveredAsins,
    competitorLookupLoader = loadSellerSpriteCompetitorLookup,
    amazonDetailLoader = null,
  } = {},
) {
  const discoveryComplete = discoveries.every((discovery) => discovery?.visit?.complete === true);
  if (input.phase === "discover" || (input.phase === "analyze" && !discoveryComplete)) {
    return {
      discoveryComplete,
      analysis: discoveryOnlyAnalysis(discoveries, input, collectedAt),
    };
  }
  const analysis = input.useSellerSprite
    ? await sellerSpriteAnalyzer(discoveries, input, collectedAt, signal, { competitorLookupLoader })
    : await amazonAnalyzer(discoveries, input, collectedAt, signal, { detailLoader: amazonDetailLoader });
  return { discoveryComplete, analysis };
}

function retryAfterMsForAmazonCode(code) {
  if (code === "AMAZON_ACCESS_CHALLENGE") return 5 * 60_000;
  if (code === "AMAZON_HTTP_429") return 60_000;
  return code ? 15_000 : 0;
}

export function resolveAmazonDiscoveryContinuation(result, { sourceLimitReached = false } = {}) {
  const terminalInterruption = TERMINAL_AMAZON_PAGINATION_CODES.has(result?.interruption?.code);
  const nextHref = !sourceLimitReached && !terminalInterruption && typeof result?.nextHref === "string" && result.nextHref
    ? result.nextHref
    : null;
  const interrupted = !sourceLimitReached && !terminalInterruption && Boolean(result?.interruption);
  const incomplete = interrupted || Boolean(nextHref);
  return {
    incomplete,
    complete: !incomplete,
    nextHref,
  };
}

function amazonPaginationInterruption(result, checkpoint) {
  if (result?.interruption || !checkpoint || !result?.nextHref || !checkpoint?.nextHref) {
    return result?.interruption || null;
  }
  const previousPages = Number(checkpoint.pagesVisited || 0);
  const currentPages = Number(result.pagesVisited || 0);
  const previousAsins = new Set(Array.isArray(checkpoint.asins) ? checkpoint.asins : []).size;
  const currentAsins = new Set(Array.isArray(result.asins) ? result.asins : []).size;
  const sameContinuation = String(result.nextHref) === String(checkpoint.nextHref);
  if (currentPages > previousPages || currentAsins > previousAsins || !sameContinuation) return null;
  return {
    code: "AMAZON_PAGINATION_NO_PROGRESS",
    message: "Amazon store pagination returned the same checkpoint without visiting a page or discovering another ASIN; automatic retries were stopped.",
  };
}

export async function discoverStore(store, amazonSession, amazonSessionError, signal, { runId, checkpoint = null } = {}) {
  const sourceStore = {
    storeIndex: store.storeIndex,
    sellerId: store.sellerId,
    sellerName: store.sellerName || checkpoint?.sellerName || null,
    rowNumbers: store.rowNumbers,
  };
  const providedAsins = [...new Set([...(store.asins || []), ...(checkpoint?.asins || [])])].slice(0, MAX_STORE_ASINS);
  if (!store.sellerId) {
    const notEnumeratedAsins = Math.max(0, store.asins.length - providedAsins.length);
    return {
      store,
      sourceStore,
      asins: providedAsins,
      errors: [],
      visit: {
        ...sourceStore,
        ...amazonStoreCoverageFields(checkpoint, store),
        status: "not_required",
        pagesVisited: 0,
        discoveredAsins: providedAsins.length,
        reportedTotalAsins: store.asins.length,
        notEnumeratedAsins,
        omissionReasons: notEnumeratedAsins
          ? [{
              code: "SOURCE_ASIN_LIMIT_REACHED",
              count: notEnumeratedAsins,
              message: `The imported source-ASIN list exceeded the ${MAX_STORE_ASINS}-item safety limit.`,
            }]
          : [],
        truncated: notEnumeratedAsins > 0,
        canonicalUrl: null,
        complete: notEnumeratedAsins === 0,
        nextHref: null,
        interruption: null,
      },
    };
  }

  if (checkpoint?.complete === true) {
    return discoveryFromAmazonCheckpoint(store, checkpoint);
  }

  if (!amazonSession) {
    const error = amazonStoreError(sourceStore, amazonSessionError);
    const retryAfterMs = error.retryable ? retryAfterMsForAmazonCode(error.code) : 0;
    const retryAt = retryAfterMs ? new Date(Date.now() + retryAfterMs).toISOString() : null;
    const status = error.retryable ? "pending" : "failed";
    await saveAmazonDiscoveryCheckpoint(runId, store, checkpoint, {
      asins: providedAsins,
      status,
      complete: false,
      interruption: { code: error.code, message: error.message },
      retryAt,
    });
    return {
      store,
      sourceStore,
      asins: providedAsins,
      errors: [error],
      visit: {
        ...sourceStore,
        ...amazonStoreCoverageFields(checkpoint, store),
        status,
        pagesVisited: Number(checkpoint?.pagesVisited || 0),
        discoveredAsins: providedAsins.length,
        reportedTotalAsins: Number.isInteger(checkpoint?.reportedTotalAsins) ? checkpoint.reportedTotalAsins : null,
        notEnumeratedAsins: Number(checkpoint?.notEnumeratedAsins || 0),
        omissionReasons: [{
          code: error.code || "AMAZON_STORE_VISIT_FAILED",
          count: null,
          message: error.message,
        }],
        truncated: true,
        canonicalUrl: checkpoint?.canonicalUrl || buildSellerUrl(store.marketplace, store.sellerId, 1),
        complete: false,
        nextHref: checkpoint?.nextHref || null,
        interruption: { code: error.code, message: error.message },
        code: error.code,
        message: error.message,
        retryAfterMs,
        retryAt,
      },
    };
  }

  try {
    const result = await amazonSession.enumerateStore(store.sellerId, {
      maxPages: MAX_STORE_PAGES,
      maxAsins: MAX_STORE_ASINS,
      signal,
      resume: checkpoint,
      onCheckpoint: (pageResult) => saveAmazonDiscoveryCheckpoint(runId, store, checkpoint, {
        ...pageResult,
        asins: [...new Set([...providedAsins, ...(pageResult.asins || [])])].slice(0, MAX_STORE_ASINS),
        status: pageResult.complete ? "complete" : pageResult.interruption ? "waiting" : "running",
        retryAt: pageResult.interruption
          ? new Date(Date.now() + retryAfterMsForAmazonCode(pageResult.interruption.code)).toISOString()
          : null,
      }),
    });
    const allAsins = [...new Set([...providedAsins, ...result.asins])];
    const resultInterruption = amazonPaginationInterruption(result, checkpoint);
    const resolvedSourceStore = {
      ...sourceStore,
      sellerName: sourceStore.sellerName || result.storeName,
    };
    const reportedTotalAsins = Number.isInteger(result.reportedTotalAsins) && result.reportedTotalAsins >= 0
      ? result.reportedTotalAsins
      : null;
    const reportedGap = reportedTotalAsins === null
      ? 0
      : Math.max(0, reportedTotalAsins - result.asins.length);
    const sourceLimitOmissions = Math.max(
      0,
      store.asins.length - MAX_STORE_ASINS,
      allAsins.length - MAX_STORE_ASINS,
    );
    const notEnumeratedAsins = Math.max(reportedGap, sourceLimitOmissions);
    const sourceLimitReached = sourceLimitOmissions > 0
      || (allAsins.length >= MAX_STORE_ASINS && Boolean(result.nextHref));
    const continuation = resolveAmazonDiscoveryContinuation(
      { ...result, interruption: resultInterruption },
      { sourceLimitReached },
    );
    const incomplete = continuation.incomplete;
    const omissionReasons = [];
    if (incomplete) {
      omissionReasons.push({
        code: "AMAZON_PAGINATION_INCOMPLETE",
        count: reportedGap > 0 ? reportedGap : null,
        message: "Amazon store pagination has more pages or is waiting to continue.",
      });
    } else if (reportedGap > 0) {
      omissionReasons.push({
        code: "AMAZON_REPORTED_TOTAL_GAP",
        count: reportedGap,
        message: "Amazon reported more store results than the unique source ASINs exposed by its product cards.",
      });
    }
    if (resultInterruption) {
      omissionReasons.push({
        code: resultInterruption.code || "AMAZON_STORE_VISIT_INTERRUPTED",
        count: null,
        message: resultInterruption.message || "Amazon store pagination was interrupted before all source ASINs were enumerated.",
      });
    }
    if (sourceLimitReached) {
      omissionReasons.push({
        code: "SOURCE_ASIN_LIMIT_REACHED",
        count: reportedGap > 0 || sourceLimitOmissions === 0 ? null : sourceLimitOmissions,
        message: `The combined source-ASIN list exceeded the ${MAX_STORE_ASINS}-item safety limit.`,
      });
    }
    // 卡片月销量只影响候选资格，不影响全部已发现商品的详情采集。
    const excludedUnder50Count = nonNegativeCountOrDefault(result.excludedUnder50Count);
    if (excludedUnder50Count > 0) {
      omissionReasons.push({
        code: "AMAZON_STORE_MONTHLY_SALES_GATE",
        count: excludedUnder50Count,
        message: "店铺卡片暂未取得 50+ 月购买量证据的商品仍保留采集，详情完成后再按有效证据筛选候选。",
      });
    }
    const interruptionCode = resultInterruption?.code || null;
    const status = !incomplete
      ? "complete"
      : ["AMAZON_ACCESS_CHALLENGE", "AMAZON_HTTP_429"].includes(interruptionCode) ? "waiting" : "pending";
    const retryAfterMs = incomplete ? retryAfterMsForAmazonCode(interruptionCode || "AMAZON_DISCOVERY_PENDING") : 0;
    const retryAt = retryAfterMs ? new Date(Date.now() + retryAfterMs).toISOString() : null;
    await saveAmazonDiscoveryCheckpoint(runId, store, checkpoint, {
      ...result,
      interruption: resultInterruption,
      asins: allAsins.slice(0, MAX_STORE_ASINS),
      notEnumeratedAsins,
      truncated: Boolean(
        result.truncated
        || store.asins.length > MAX_STORE_ASINS
        || allAsins.length > MAX_STORE_ASINS
        || notEnumeratedAsins > 0
      ),
      complete: !incomplete,
      nextHref: continuation.nextHref,
      status,
      retryAt,
    });
    return {
      store,
      sourceStore: resolvedSourceStore,
      asins: allAsins.slice(0, MAX_STORE_ASINS),
      salesByAsin: isPlainObject(result.salesByAsin) ? result.salesByAsin : {},
      errors: [],
      visit: {
        ...resolvedSourceStore,
        ...amazonStoreCoverageFields(result, store, { complete: !incomplete, nextHref: continuation.nextHref, interruption: resultInterruption, notEnumeratedAsins, truncated: result.truncated || incomplete || sourceLimitReached || notEnumeratedAsins > 0 }),
        status: incomplete ? status : result.asins.length ? "visited" : "empty",
        pagesVisited: result.pagesVisited,
        discoveredAsins: result.asins.length,
        reportedTotalAsins,
        notEnumeratedAsins,
        excludedUnder50Count,
        omissionReasons,
        truncated: Boolean(
          result.truncated
          || store.asins.length > MAX_STORE_ASINS
          || allAsins.length > MAX_STORE_ASINS
          || notEnumeratedAsins > 0
        ),
        canonicalUrl: result.canonicalUrl,
        deliveryPostalCode: result.deliveryPostalCode,
        deliveryRegionReady: result.deliveryRegionReady === true,
        deliveryRegionMode: result.deliveryRegionMode,
        complete: !incomplete,
        nextHref: continuation.nextHref,
        interruption: resultInterruption,
        code: interruptionCode,
        message: resultInterruption?.message || null,
        retryAfterMs,
        retryAt,
      },
    };
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof PersistenceStoreError) throw error;
    const normalized = amazonStoreError(sourceStore, error);
    const waiting = ["AMAZON_ACCESS_CHALLENGE", "AMAZON_HTTP_429"].includes(normalized.code);
    const status = waiting ? "waiting" : normalized.retryable ? "pending" : "failed";
    const retryAfterMs = normalized.retryable ? retryAfterMsForAmazonCode(normalized.code) : 0;
    const retryAt = retryAfterMs ? new Date(Date.now() + retryAfterMs).toISOString() : null;
    await saveAmazonDiscoveryCheckpoint(runId, store, checkpoint, {
      asins: providedAsins,
      pagesVisited: Number(checkpoint?.pagesVisited || 0),
      reportedTotalAsins: Number.isInteger(checkpoint?.reportedTotalAsins) ? checkpoint.reportedTotalAsins : null,
      notEnumeratedAsins: Number(checkpoint?.notEnumeratedAsins || 0),
      truncated: true,
      complete: false,
      nextHref: checkpoint?.nextHref || null,
      canonicalUrl: checkpoint?.canonicalUrl || buildSellerUrl(store.marketplace, store.sellerId, 1),
      interruption: { code: normalized.code, message: normalized.message },
      status,
      retryAt,
    });
    return {
      store,
      sourceStore,
      asins: providedAsins,
      salesByAsin: {},
      errors: [normalized],
      visit: {
        ...sourceStore,
        ...amazonStoreCoverageFields(checkpoint, store),
        status,
        pagesVisited: Number(checkpoint?.pagesVisited || 0),
        discoveredAsins: providedAsins.length,
        reportedTotalAsins: Number.isInteger(checkpoint?.reportedTotalAsins) ? checkpoint.reportedTotalAsins : null,
        notEnumeratedAsins: Number(checkpoint?.notEnumeratedAsins || 0),
        excludedUnder50Count: 0,
        omissionReasons: [{
          code: normalized.code || "AMAZON_STORE_VISIT_FAILED",
          count: null,
          message: normalized.message,
        }],
        truncated: true,
        canonicalUrl: checkpoint?.canonicalUrl || buildSellerUrl(store.marketplace, store.sellerId, 1),
        code: normalized.code,
        message: normalized.message,
        complete: false,
        nextHref: checkpoint?.nextHref || null,
        interruption: { code: normalized.code, message: normalized.message },
        retryAfterMs,
        retryAt,
      },
    };
  }
}

async function saveAmazonDiscoveryCheckpoint(runId, store, previous, next) {
  if (!runId || !store?.sellerId) return null;
  const has = (field) => Object.hasOwn(next || {}, field);
  return persistenceStore.saveAmazonStoreCheckpoint(runId, {
    marketplace: store.marketplace,
    sellerId: store.sellerId,
    sellerName: store.sellerName || next?.storeName || previous?.sellerName || null,
    storeIndex: store.storeIndex,
    rowNumbers: store.rowNumbers,
    asins: [...new Set([...(previous?.asins || []), ...(next?.asins || [])])].slice(0, MAX_STORE_ASINS),
    pagesVisited: has("pagesVisited") ? next.pagesVisited : Number(previous?.pagesVisited || 0),
    reportedTotalAsins: has("reportedTotalAsins") ? next.reportedTotalAsins : previous?.reportedTotalAsins ?? null,
    notEnumeratedAsins: has("notEnumeratedAsins") ? next.notEnumeratedAsins : Number(previous?.notEnumeratedAsins || 0),
    pageAudit: has("pageAudit") ? next.pageAudit : previous?.pageAudit || [],
    coverageEvidence: has("coverageEvidence") ? next.coverageEvidence : previous?.coverageEvidence || null,
    truncated: has("truncated") ? next.truncated === true : previous?.truncated === true,
    complete: has("complete") ? next.complete === true : previous?.complete === true,
    nextHref: has("nextHref") ? next.nextHref : previous?.nextHref || null,
    canonicalUrl: next?.canonicalUrl || previous?.canonicalUrl || buildSellerUrl(store.marketplace, store.sellerId, 1),
    interruption: has("interruption") ? next.interruption : previous?.interruption || null,
    status: next?.status || previous?.status || "pending",
    deliveryPostalCode: next?.deliveryPostalCode || previous?.deliveryPostalCode || null,
    deliveryRegionReady: has("deliveryRegionReady")
      ? next.deliveryRegionReady === true
      : previous?.deliveryRegionReady === true,
    deliveryRegionMode: next?.deliveryRegionMode || previous?.deliveryRegionMode || null,
    attempt: Number(previous?.attempt || 0) + 1,
    retryAt: has("retryAt") ? next.retryAt : previous?.retryAt || null,
    updatedAt: new Date().toISOString(),
  });
}

export async function analyzeDiscoveredAsins(
  discoveries,
  input,
  collectedAt,
  signal,
  {
    detailLoader = loadSellerSpriteAsinDetail,
    detailPersistence = persistenceStore,
    competitorLookupLoader = null,
    competitorLookupPersistence = detailPersistence,
    rateLimitWaiter = waitForRateLimitWindow,
    rateLimitDelayMs = SELLERSPRITE_RATE_LIMIT_RETRY_DELAY_MS,
  } = {},
) {
  const targets = collectDiscoveredAsinTargets(discoveries);
  const providerMarketplace = sellerSpriteProviderFor(input.marketplace).providerMarketplace;
  const persistedDetails = await detailPersistence.getAsinDetailResults(input.runId);
  const results = [];
  const rateLimitEvents = [];
  for (const target of targets) {
    throwIfAborted(signal);
    let callCount = 0;
    let rateLimitRetryCount = 0;
    let rateLimitWaitMs = 0;
    while (true) {
      try {
        const cached = await getRunAsinDetail({
          runId: input.runId,
          providerMarketplace,
          asin: target.asin,
          signal,
          detailLoader,
          detailPersistence,
          persistedDetails,
        });
        if (!cached.cacheHit) callCount += 1;
        const item = normalizeSellerSpriteItem(cached.data, {
          marketplace: input.marketplace,
          sourceTool: "asin_detail",
          sourceStore: target.sourceStores[0] || {},
          collectedAt,
          requestedAsin: target.asin,
        });
        if (!item) {
          results.push(failedSourceAsinResult(target, input, collectedAt, {
            code: "INVALID_PROVIDER_ITEM",
            message: "SellerSprite ASIN Detail did not return a usable product object.",
            retryable: false,
          }, {
            cacheHit: cached.cacheHit,
            callCount,
            status: "invalid",
            rateLimitRetryCount,
            rateLimitWaitMs,
          }));
          break;
        }
        results.push({
          item: {
            ...item,
            id: `${input.marketplace}:${target.asin}`,
            asin: target.asin,
            sourceAsin: target.asin,
            sourceAsins: [target.asin],
            sourceStores: target.sourceStores,
            enrichmentTools: ["asin_detail"],
            detailStatus: "success",
            detailError: null,
            detailAttempts: callCount,
            detailRateLimitRetries: rateLimitRetryCount,
            detailRateLimitWaitMs: rateLimitWaitMs,
            missingFields: collectSellerSpriteMissingFields(item),
          },
          errors: [],
          cacheHit: cached.cacheHit,
          callCount,
          rateLimitRetryCount,
          rateLimitWaitMs,
        });
        break;
      } catch (error) {
        throwIfAborted(signal);
        if (error?.code === "LOCAL_PERSISTENCE_FAILED") throw error;
        const cacheHit = Boolean(error?.asinDetailCacheHit);
        if (!cacheHit) callCount += 1;
        const failure = {
          code: providerErrorCode(error),
          message: cleanOptionalText(error?.message, 500),
          retryable: isRetryableProviderError(error),
        };
        if (isMinuteRateLimitError(failure.code)) {
          clearAsinDetailRequest(input.runId, providerMarketplace, target.asin);
          const waitMs = Math.max(0, Number(rateLimitDelayMs) || 0);
          rateLimitEvents.push({
            asin: target.asin,
            code: failure.code,
            retry: rateLimitRetryCount + 1,
            waitMs,
          });
          rateLimitWaitMs += waitMs;
          await rateLimitWaiter(waitMs, signal);
          rateLimitRetryCount += 1;
          continue;
        }
        results.push(failedSourceAsinResult(target, input, collectedAt, failure, {
          cacheHit,
          callCount,
          rateLimitRetryCount,
          rateLimitWaitMs,
        }));
        break;
      }
    }
  }
  const competitorLookup = await enrichWithSellerSpriteCompetitorLookup({
    results,
    targets,
    input,
    collectedAt,
    signal,
    competitorLookupLoader,
    competitorLookupPersistence,
    rateLimitWaiter,
    rateLimitDelayMs,
  });
  const finalResults = competitorLookup.results;
  const successfulAsins = new Set(finalResults.flatMap((result) => result.item?.detailStatus === "success" ? [result.item.sourceAsin] : []));
  const failedAsins = new Set(finalResults.flatMap((result) => result.item?.detailStatus === "success" ? [] : [result.item?.sourceAsin]).filter(Boolean));
  const cacheHits = finalResults.filter((result) => result.cacheHit).length;
  const storeAudits = discoveries.map((discovery) => {
    const uniqueAsins = [...new Set(discovery.asins)];
    return {
      ...emptyStoreAnalysisAudit(),
      uniqueAsins: uniqueAsins.length,
      detailRequested: uniqueAsins.length,
      detailReturned: uniqueAsins.filter((asin) => successfulAsins.has(asin)).length,
      detailFailed: uniqueAsins.filter((asin) => failedAsins.has(asin)).length,
      wideCandidates: uniqueAsins.length,
      detailRateLimitWaits: finalResults
        .filter((result) => result.item.sourceStores.some((store) => store.storeIndex === discovery.sourceStore?.storeIndex))
        .reduce((total, result) => total + result.rateLimitRetryCount, 0),
      rateLimitWaits: finalResults
        .filter((result) => result.item.sourceStores.some((store) => store.storeIndex === discovery.sourceStore?.storeIndex))
        .reduce((total, result) => total + result.rateLimitRetryCount, 0),
      rateLimitRetries: finalResults
        .filter((result) => result.item.sourceStores.some((store) => store.storeIndex === discovery.sourceStore?.storeIndex))
        .reduce((total, result) => total + result.rateLimitRetryCount, 0),
      rateLimitWaitMs: finalResults
        .filter((result) => result.item.sourceStores.some((store) => store.storeIndex === discovery.sourceStore?.storeIndex))
        .reduce((total, result) => total + result.rateLimitWaitMs, 0),
    };
  });
  return {
    items: finalResults.map((result) => result.item),
    errors: [...finalResults.flatMap((result) => result.errors), ...competitorLookup.errors],
    storeAudits,
    audit: {
      uniqueAsins: targets.length,
      detailRequested: targets.length,
      detailCallsStarted: finalResults.reduce((total, result) => total + result.callCount, 0),
      detailCacheHits: cacheHits,
      detailReturned: successfulAsins.size,
      detailFailed: failedAsins.size,
      retainedSourceAsins: finalResults.length,
      detailRateLimitWaits: rateLimitEvents.length,
      detailRateLimitRetries: finalResults.reduce((total, result) => total + result.rateLimitRetryCount, 0),
      detailRateLimitWaitMs: finalResults.reduce((total, result) => total + result.rateLimitWaitMs, 0),
      ...competitorLookup.audit,
      rateLimitWaits: rateLimitEvents.length + competitorLookup.audit.competitorLookupRateLimitWaits,
      rateLimitRetries: finalResults.reduce((total, result) => total + result.rateLimitRetryCount, 0) + competitorLookup.audit.competitorLookupRateLimitRetries,
      rateLimitWaitMs: finalResults.reduce((total, result) => total + result.rateLimitWaitMs, 0) + competitorLookup.audit.competitorLookupRateLimitWaitMs,
      rateLimitEvents: [...rateLimitEvents, ...competitorLookup.rateLimitEvents],
    },
  };
}

export async function analyzeAmazonDiscoveredAsins(
  discoveries,
  input,
  collectedAt,
  signal,
  { detailLoader } = {},
) {
  if (typeof detailLoader !== "function") throw new TypeError("detailLoader must be a function.");
  const requestedDetailAsins = new Set(Array.isArray(input.detailAsins) ? input.detailAsins : []);
  const targets = collectDiscoveredAsinTargets(discoveries)
    .filter((target) => !requestedDetailAsins.size || requestedDetailAsins.has(target.asin));
  // 同节点适度并发：多个详情请求并行，摊薄单请求的串行等待，同时受并发上限约束避免触发 WAF。
  const detailConcurrency = Number.isFinite(Number(input.detailConcurrency)) && Number(input.detailConcurrency) > 0
    ? Math.min(6, Math.max(1, Math.trunc(Number(input.detailConcurrency))))
    : Number.isFinite(Number(process.env.AMAZON_DETAIL_CONCURRENCY)) && Number(process.env.AMAZON_DETAIL_CONCURRENCY) > 0
      ? Math.min(6, Math.max(1, Math.trunc(Number(process.env.AMAZON_DETAIL_CONCURRENCY))))
      : 3;
  const results = await mapWithConcurrency(targets, detailConcurrency, async (target) => {
    throwIfAborted(signal);
    try {
      const detail = await detailLoader(target.asin, { signal });
      const item = normalizeAmazonProductItem(detail, target, input, collectedAt);
      if (!item) {
        throw new AmazonStoreError("AMAZON_PRODUCT_INVALID", "Amazon returned an unusable product detail page.");
      }
      return { item, errors: [], callCount: 1, cacheHit: false, rateLimitRetryCount: 0, rateLimitWaitMs: 0 };
    } catch (error) {
      throwIfAborted(signal);
      return failedAmazonProductResult(target, input, collectedAt, error);
    }
  }, signal);

  const successfulAsins = new Set(results.flatMap((result) => result.item.detailStatus === "success" ? [result.item.sourceAsin] : []));
  const failedAsins = new Set(results.flatMap((result) => result.item.detailStatus === "success" ? [] : [result.item.sourceAsin]));
  const storeAudits = discoveries.map((discovery) => {
    const uniqueAsins = [...new Set(discovery.asins)]
      .filter((asin) => !requestedDetailAsins.size || requestedDetailAsins.has(asin));
    return {
      ...emptyStoreAnalysisAudit(),
      uniqueAsins: uniqueAsins.length,
      detailRequested: uniqueAsins.length,
      detailCallsStarted: uniqueAsins.length,
      detailReturned: uniqueAsins.filter((asin) => successfulAsins.has(asin)).length,
      detailFailed: uniqueAsins.filter((asin) => failedAsins.has(asin)).length,
      wideCandidates: uniqueAsins.length,
    };
  });

  return {
    items: results.map((result) => result.item),
    errors: results.flatMap((result) => result.errors),
    storeAudits,
    audit: {
      uniqueAsins: targets.length,
      detailRequested: targets.length,
      detailCallsStarted: targets.length,
      detailCacheHits: 0,
      detailReturned: successfulAsins.size,
      detailFailed: failedAsins.size,
      retainedSourceAsins: results.length,
      detailRateLimitWaits: 0,
      detailRateLimitRetries: 0,
      detailRateLimitWaitMs: 0,
      ...emptyCompetitorLookupAudit(),
      rateLimitWaits: 0,
      rateLimitRetries: 0,
      rateLimitWaitMs: 0,
      rateLimitEvents: [],
    },
  };
}

function normalizeAmazonProductItem(detail, target, input, collectedAt) {
  if (!isPlainObject(detail) || normalizeAsin(detail.asin) !== target.asin) return null;
  const sourceStore = target.sourceStores[0] || {};
  const directProductWeightKg = firstNonNegativeNumber(detail.productWeightKg);
  const fbaPackageWeightKg = firstNonNegativeNumber(detail.packageWeightKg);
  const productWeightKg = directProductWeightKg ?? fbaPackageWeightKg;
  const fieldSources = { ...(detail.fieldSources || {}) };
  if (fieldSources.packageWeightKg && !fieldSources.fbaPackageWeightKg) {
    fieldSources.fbaPackageWeightKg = fieldSources.packageWeightKg;
  }
  if (directProductWeightKg === null && fbaPackageWeightKg !== null) {
    fieldSources.productWeightKg = "amazon_package_weight_fallback";
  }
  // 亚马逊准则 2026-10-09：详情页未展示月销量角标时，回退使用店铺首页卡片读到的角标下界
  //（卡片 50+/100+/200+/1000+ → 50/100/200/1000+），保证店铺首页观察到的销量档位不丢失。
  const detailSales30 = firstNonNegativeInteger(detail.sales30);
  const cardSales30 = firstNonNegativeInteger(target.sales30);
  const sales30 = detailSales30 ?? cardSales30;
  const sales30Evidence = detail.sales30Evidence
    ?? (detailSales30 === null && cardSales30 !== null ? target.sales30Evidence || null : null);
  if (detailSales30 === null && cardSales30 !== null) {
    fieldSources.sales30 = "amazon_store_card";
  }
  const item = {
    id: `${input.marketplace}:${target.asin}`,
    marketplace: input.marketplace,
    sourceMarketplace: input.marketplace,
    providerMarketplace: null,
    providerMode: null,
    analysisSourceMode: "amazon_only",
    parentAsin: null,
    asin: target.asin,
    parentResolved: false,
    sourceAsin: target.asin,
    sourceAsins: [target.asin],
    title: cleanOptionalText(detail.title, 2_000),
    sellerId: sourceStore.sellerId || null,
    sellerName: sourceStore.sellerName || null,
    currentPrice: firstNonNegativeNumber(detail.currentPrice),
    priceEvidence: detail.priceEvidence || null,
    pageContextEvidence: detail.pageContextEvidence || null,
    sales30,
    sales30Evidence,
    sales60: null,
    salesAmount30: null,
    sales30UpdatedAt: null,
    parentSales30: null,
    parentSalesAmount30: null,
    fbaFee: null,
    fbaFeeSource: null,
    primePrice: null,
    deliveryPrice: null,
    listingAvailableAt: null,
    rating: boundedNumber(detail.rating, 0, 5),
    ratingEvidence: detail.ratingEvidence || null,
    reviewCount: firstNonNegativeInteger(detail.reviewCount),
    reviewCountEvidence: detail.reviewCountEvidence || null,
    hasAPlus: null,
    productWeightKg,
    productWeightEvidence: directProductWeightKg !== null ? detail.productWeightEvidence || null : detail.packageWeightEvidence || null,
    fbaPackageWeightKg,
    packageWeightEvidence: detail.packageWeightEvidence || null,
    productDimensionsCm: null,
    fbaPackageDimensionsCm: null,
    fulfillment: null,
    imageUrl: normalizeHttpUrl(detail.imageUrl),
    canonicalUrl: normalizeAmazonProductUrl(detail.canonicalUrl, { marketplace: input.marketplace, asin: target.asin }),
    dataSource: "amazon-product-page",
    sourceTool: "amazon_product_page",
    fieldSources,
    sourceStores: target.sourceStores,
    collectedAt,
    enrichmentTools: ["amazon_product_page"],
    detailStatus: "success",
    detailErrorCode: null,
    detailError: null,
    detailRetryable: false,
    detailAttempts: 1,
    detailParserVersion: AMAZON_PRODUCT_DETAIL_PARSER_VERSION,
    detailRateLimitRetries: 0,
    detailRateLimitWaitMs: 0,
    competitorLookupStatus: "not_requested",
  };
  item.missingFields = collectAmazonProductMissingFields(item);
  item.collectionQuality = auditAmazonProductFields(item, { marketplace: input.marketplace, now: collectedAt });
  return item;
}

function failedAmazonProductResult(target, input, collectedAt, error) {
  const sourceStore = target.sourceStores[0] || {};
  const normalized = amazonProductError(sourceStore, target.asin, error);
  const item = normalizeAmazonProductItem({ asin: target.asin }, target, input, collectedAt) || {};
  Object.assign(item, {
    detailStatus: "failed",
    detailErrorCode: normalized.code,
    detailError: normalized.message,
    detailRetryable: normalized.retryable,
    detailAttempts: 1,
    enrichmentTools: [],
    dataSource: "amazon-product-page-failed",
  });
  item.missingFields = collectAmazonProductMissingFields(item);
  return {
    item,
    errors: target.sourceStores.map((store) => amazonProductError(store, target.asin, error)),
    callCount: 1,
    cacheHit: false,
    rateLimitRetryCount: 0,
    rateLimitWaitMs: 0,
  };
}

function collectAmazonProductMissingFields(item) {
  const missing = [];
  if (!item.title) missing.push("title");
  if (!Number.isFinite(item.currentPrice)) missing.push("currentPrice");
  if (!Number.isFinite(item.rating)) missing.push("rating");
  if (!Number.isFinite(item.reviewCount)) missing.push("reviewCount");
  if (!Number.isFinite(item.productWeightKg) && !Number.isFinite(item.fbaPackageWeightKg)) missing.push("weight");
  if (!item.imageUrl) missing.push("imageUrl");
  return missing;
}

async function enrichWithSellerSpriteCompetitorLookup({
  results,
  targets,
  input,
  collectedAt,
  signal,
  competitorLookupLoader,
  competitorLookupPersistence,
  rateLimitWaiter,
  rateLimitDelayMs,
}) {
  const providerMarketplace = sellerSpriteProviderFor(input.marketplace).providerMarketplace;
  const audit = emptyCompetitorLookupAudit();
  const errors = [];
  const rateLimitEvents = [];
  const resultByAsin = new Map(results.map((result) => [normalizeAsin(result.item?.sourceAsin), result]));
  if (typeof competitorLookupLoader !== "function") {
    return { results, errors, audit, rateLimitEvents };
  }
  if (!COMPETITOR_LOOKUP_MARKETPLACES.has(providerMarketplace)) {
    audit.competitorLookupSupported = false;
    audit.competitorLookupSkipped = targets.length;
    for (const target of targets) {
      markCompetitorLookupUnavailable(resultByAsin.get(target.asin), {
        status: "unsupported",
        code: "COMPETITOR_LOOKUP_MARKETPLACE_UNSUPPORTED",
        message: `SellerSprite competitor lookup does not list marketplace ${providerMarketplace} as supported.`,
      });
    }
    return { results, errors, audit, rateLimitEvents };
  }

  audit.competitorLookupSupported = true;
  audit.competitorLookupRequested = targets.length;
  const persisted = typeof competitorLookupPersistence?.getCompetitorLookupResults === "function"
    ? await competitorLookupPersistence.getCompetitorLookupResults(input.runId)
    : {};
  const pendingTargets = [];
  for (const target of targets) {
    const key = competitorLookupCheckpointKey(providerMarketplace, COMPETITOR_LOOKUP_MONTH, target.asin);
    const entry = persisted?.[key];
    if (entry?.status === "success" || entry?.status === "empty") {
      audit.competitorLookupCacheHits += 1;
      applyCompetitorLookupCheckpoint(resultByAsin.get(target.asin), target, entry, input, collectedAt);
      if (entry.status === "success") audit.competitorLookupReturned += 1;
      else audit.competitorLookupMissing += 1;
    } else {
      pendingTargets.push(target);
    }
  }

  const batches = chunkValues(pendingTargets, COMPETITOR_LOOKUP_BATCH_SIZE);
  audit.competitorLookupBatches = batches.length;
  let stopAfterSessionError = null;
  for (const batch of batches) {
    throwIfAborted(signal);
    if (stopAfterSessionError) {
      for (const target of batch) {
        markCompetitorLookupUnavailable(resultByAsin.get(target.asin), stopAfterSessionError);
        errors.push(...competitorLookupErrorsForTarget(target, stopAfterSessionError));
        audit.competitorLookupFailed += 1;
      }
      continue;
    }
    let rateLimitRetry = 0;
    while (true) {
      try {
        audit.competitorLookupCallsStarted += 1;
        const data = await competitorLookupLoader({
          runId: input.runId,
          marketplace: providerMarketplace,
          month: COMPETITOR_LOOKUP_MONTH,
          asins: batch.map((target) => target.asin),
          signal,
        });
        const requested = new Set(batch.map((target) => target.asin));
        const accepted = [];
        const acceptedAsins = new Set();
        for (const raw of extractCompetitorLookupItems(data)) {
          const asin = normalizeAsin(raw?.asin);
          if (!asin || !requested.has(asin) || acceptedAsins.has(asin)) {
            const sourceStore = batch[0]?.sourceStores?.[0] || {};
            errors.push({
              ...sellerSpriteError(
                sourceStore,
                asin && !requested.has(asin) ? "SELLSPRITE_UNREQUESTED_ASIN" : "INVALID_PROVIDER_ITEM",
                false,
                asin,
                "sellsprite_competitor",
              ),
              message: asin && !requested.has(asin)
                ? "SellerSprite competitor lookup returned an ASIN outside this requested batch; it was ignored."
                : "SellerSprite competitor lookup returned an invalid or duplicate ASIN item; it was ignored.",
            });
            continue;
          }
          acceptedAsins.add(asin);
          accepted.push(raw);
        }
        if (typeof competitorLookupPersistence?.saveCompetitorLookupBatch !== "function") {
          const error = new Error("The SellerSprite competitor result could not be checkpointed locally.");
          error.code = "LOCAL_PERSISTENCE_FAILED";
          throw error;
        }
        try {
          await competitorLookupPersistence.saveCompetitorLookupBatch(input.runId, {
            marketplace: providerMarketplace,
            month: COMPETITOR_LOOKUP_MONTH,
            requestedAsins: batch.map((target) => target.asin),
            items: accepted,
            collectedAt,
          });
        } catch (cause) {
          const checkpointError = new Error("The SellerSprite competitor result could not be checkpointed locally.");
          checkpointError.code = "LOCAL_PERSISTENCE_FAILED";
          checkpointError.cause = cause;
          throw checkpointError;
        }
        for (const target of batch) {
          const raw = accepted.find((item) => normalizeAsin(item.asin) === target.asin) || null;
          const entry = {
            status: raw ? "success" : "empty",
            marketplace: providerMarketplace,
            month: COMPETITOR_LOOKUP_MONTH,
            asin: target.asin,
            collectedAt,
            data: raw,
          };
          applyCompetitorLookupCheckpoint(resultByAsin.get(target.asin), target, entry, input, collectedAt);
          if (raw) audit.competitorLookupReturned += 1;
          else audit.competitorLookupMissing += 1;
        }
        break;
      } catch (error) {
        throwIfAborted(signal);
        if (error?.code === "LOCAL_PERSISTENCE_FAILED") throw error;
        const failure = {
          status: "failed",
          code: providerErrorCode(error),
          message: cleanOptionalText(error?.message, 500) || "SellerSprite competitor lookup failed.",
          retryable: isRetryableProviderError(error),
        };
        if (isMinuteRateLimitError(failure.code)) {
          const waitMs = Math.max(0, Number(rateLimitDelayMs) || 0);
          rateLimitEvents.push({
            asins: batch.map((target) => target.asin),
            tool: "competitor_lookup",
            code: failure.code,
            retry: rateLimitRetry + 1,
            waitMs,
          });
          audit.competitorLookupRateLimitWaits += 1;
          audit.competitorLookupRateLimitRetries += 1;
          audit.competitorLookupRateLimitWaitMs += waitMs;
          await rateLimitWaiter(waitMs, signal);
          rateLimitRetry += 1;
          continue;
        }
        if (new Set(["SELLSPRITE_SESSION_LOST", "SELLSPRITE_CONNECT_REQUIRED", "SELLSPRITE_AUTH_REQUIRED"]).has(failure.code)) {
          stopAfterSessionError = failure;
        }
        for (const target of batch) {
          markCompetitorLookupUnavailable(resultByAsin.get(target.asin), failure);
          errors.push(...competitorLookupErrorsForTarget(target, failure));
          audit.competitorLookupFailed += 1;
        }
        break;
      }
    }
  }
  return { results, errors, audit, rateLimitEvents };
}

function emptyCompetitorLookupAudit() {
  return {
    competitorLookupSupported: null,
    competitorLookupRequested: 0,
    competitorLookupSkipped: 0,
    competitorLookupBatches: 0,
    competitorLookupCallsStarted: 0,
    competitorLookupCacheHits: 0,
    competitorLookupReturned: 0,
    competitorLookupMissing: 0,
    competitorLookupFailed: 0,
    competitorLookupRateLimitWaits: 0,
    competitorLookupRateLimitRetries: 0,
    competitorLookupRateLimitWaitMs: 0,
  };
}

function competitorLookupCheckpointKey(marketplace, month, asin) {
  return `${marketplace}:${month}:${asin}`;
}

function chunkValues(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function extractCompetitorLookupItems(data) {
  if (Array.isArray(data)) return data;
  if (isPlainObject(data) && Array.isArray(data.items)) return data.items;
  throw new ProviderError("INVALID_PROVIDER_RESPONSE");
}

function applyCompetitorLookupCheckpoint(result, target, entry, input, collectedAt) {
  if (!result?.item) return;
  if (entry.status !== "success" || !isPlainObject(entry.data)) {
    markCompetitorLookupUnavailable(result, {
      status: "empty",
      code: "COMPETITOR_LOOKUP_ASIN_NOT_RETURNED",
      message: "SellerSprite competitor lookup did not return this requested ASIN.",
    });
    return;
  }
  const normalized = normalizeSellerSpriteItem(entry.data, {
    marketplace: input.marketplace,
    sourceTool: "competitor_lookup",
    sourceStore: target.sourceStores[0] || {},
    collectedAt: entry.collectedAt || collectedAt,
    requestedAsin: target.asin,
  });
  if (!normalized || normalized.sourceAsin !== target.asin) {
    markCompetitorLookupUnavailable(result, {
      status: "invalid",
      code: "INVALID_PROVIDER_ITEM",
      message: "SellerSprite competitor lookup returned an unusable ASIN record.",
    });
    return;
  }
  result.item = mergeSellerSpriteCompetitorItem(result.item, normalized);
  result.item.competitorLookupStatus = "success";
  result.item.competitorLookupErrorCode = null;
  result.item.competitorLookupError = null;
  result.item.competitorLookupCollectedAt = entry.collectedAt || collectedAt;
  result.item.missingFields = collectSellerSpriteMissingFields(result.item);
}

function mergeSellerSpriteCompetitorItem(primary, competitor) {
  const merged = { ...primary };
  const authoritativeFields = [
    "parentAsin", "title", "currentPrice", "sales30", "salesAmount30", "sales30UpdatedAt", "parentSales30",
    "parentSalesAmount30", "listingAvailableAt", "rating", "reviewCount", "hasAPlus", "fbaFee", "primePrice",
    "deliveryPrice", "productWeightKg", "fbaPackageWeightKg", "productDimensionsCm", "fbaPackageDimensionsCm",
    "fulfillment", "imageUrl",
  ];
  for (const field of authoritativeFields) {
    if (competitor[field] !== null && competitor[field] !== undefined && competitor[field] !== "") {
      merged[field] = competitor[field];
    }
  }
  merged.parentResolved = Boolean(competitor.parentResolved || primary.parentResolved);
  merged.fieldSources = { ...(primary.fieldSources || {}) };
  for (const [field, source] of Object.entries(competitor.fieldSources || {})) {
    if (source && competitor[field] !== null && competitor[field] !== undefined && competitor[field] !== "") {
      merged.fieldSources[field] = source;
    }
  }
  merged.fbaFeeSource = Number.isFinite(competitor.fbaFee) ? "competitor_lookup" : primary.fbaFeeSource || null;
  merged.enrichmentTools = [...new Set([...(primary.enrichmentTools || []), "competitor_lookup"] )];
  return merged;
}

function markCompetitorLookupUnavailable(result, failure) {
  if (!result?.item) return;
  result.item.competitorLookupStatus = failure.status || "failed";
  result.item.competitorLookupErrorCode = failure.code || "COMPETITOR_LOOKUP_FAILED";
  result.item.competitorLookupError = failure.message || "SellerSprite competitor lookup failed.";
}

function competitorLookupErrorsForTarget(target, failure) {
  return target.sourceStores.map((store) => ({
    ...sellerSpriteError(store, failure.code, Boolean(failure.retryable), target.asin, "sellsprite_competitor"),
    message: failure.message,
  }));
}

export function collectDiscoveredAsinTargets(discoveries) {
  const byAsin = new Map();
  for (const discovery of discoveries) {
    const cardSales = isPlainObject(discovery.salesByAsin) ? discovery.salesByAsin : {};
    for (const asin of discovery.asins || []) {
      const normalizedAsin = normalizeAsin(asin);
      if (!normalizedAsin) continue;
      const target = byAsin.get(normalizedAsin) || { asin: normalizedAsin, sourceStores: [] };
      target.sourceStores = deduplicateSourceStores([
        ...target.sourceStores,
        discovery.sourceStore,
      ].filter(Boolean));
      // 店铺首页卡片角标读数随 target 传递，供商品条目在详情采集前预填月销量下界。
      const cardSale = cardSales[normalizedAsin];
      const verifiedCardSales = amazonMonthlySalesValue({ asin: normalizedAsin, sales30Evidence: {
        source: "amazon_store_card", asin: normalizedAsin, period: "past_month", kind: "lower_bound",
        value: cardSale?.sales30, rawText: cardSale?.rawText,
      } });
      if (verifiedCardSales !== null && firstNonNegativeInteger(target.sales30) === null) {
        target.sales30 = verifiedCardSales;
        target.sales30Evidence = isPlainObject(cardSale)
          ? {
            source: "amazon_store_card",
            selector: "store_card_social_proofing",
            rawText: String(cardSale.rawText || "").replace(/\s+/g, " ").trim() || null,
            value: target.sales30,
            asin: normalizedAsin,
            period: "past_month",
            kind: "lower_bound",
          }
          : null;
      }
      byAsin.set(normalizedAsin, target);
    }
  }
  return [...byAsin.values()];
}

async function getRunAsinDetail({
  runId,
  providerMarketplace,
  asin,
  signal,
  detailLoader,
  detailPersistence,
  persistedDetails = {},
}) {
  const cacheKey = `${runId}\u0000${providerMarketplace}\u0000${asin}`;
  const persistedKey = `${providerMarketplace}:${asin}`;
  const persisted = persistedDetails[persistedKey];
  if (persisted?.status === "success" && isPlainObject(persisted.data)) {
    return { data: persisted.data, cacheHit: true, persistentHit: true };
  }
  const now = Date.now();
  pruneAsinDetailCache(now);
  const cached = asinDetailRequestsByRun.get(cacheKey);
  if (cached) {
    cached.lastAccessedAt = now;
    try {
      return { data: await cached.promise, cacheHit: true };
    } catch (cause) {
      const error = new Error(String(cause?.message || "SellerSprite ASIN Detail failed."));
      error.code = cause?.code;
      error.cause = cause;
      error.asinDetailCacheHit = true;
      throw error;
    }
  }
  const entry = { promise: null, createdAt: now, lastAccessedAt: now, settled: false };
  entry.promise = Promise.resolve().then(async () => {
    const data = await detailLoader({
      runId,
      marketplace: providerMarketplace,
      asin,
      signal,
    });
    try {
      await detailPersistence.saveAsinDetailResult(runId, {
        marketplace: providerMarketplace,
        asin,
        data,
      });
      persistedDetails[persistedKey] = { status: "success", data };
    } catch (cause) {
      const error = new Error("The SellerSprite result could not be checkpointed locally.");
      error.code = "LOCAL_PERSISTENCE_FAILED";
      error.cause = cause;
      throw error;
    }
    return data;
  }).finally(() => {
    entry.settled = true;
    entry.lastAccessedAt = Date.now();
  });
  asinDetailRequestsByRun.set(cacheKey, entry);
  return { data: await entry.promise, cacheHit: false };
}

function pruneAsinDetailCache(now = Date.now()) {
  for (const [key, entry] of asinDetailRequestsByRun) {
    if (entry.settled && now - entry.lastAccessedAt > ASIN_DETAIL_CACHE_TTL_MS) {
      asinDetailRequestsByRun.delete(key);
    }
  }
  if (asinDetailRequestsByRun.size < MAX_ASIN_DETAIL_CACHE_ENTRIES) return;
  const settled = [...asinDetailRequestsByRun.entries()]
    .filter(([, entry]) => entry.settled)
    .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);
  for (const [key] of settled) {
    if (asinDetailRequestsByRun.size < MAX_ASIN_DETAIL_CACHE_ENTRIES) break;
    asinDetailRequestsByRun.delete(key);
  }
}

async function loadSellerSpriteAsinDetail({ runId, marketplace, asin, signal }) {
  const result = await callSellerSpriteToolLimited("asin_detail", {
    marketplace,
    asin,
  }, { signal, runId });
  return extractToolData(result);
}

async function loadSellerSpriteCompetitorLookup({ runId, marketplace, month, asins, signal }) {
  const result = await callSellerSpriteToolLimited("competitor_lookup", {
    request: {
      marketplace,
      month,
      asins,
      variation: "Y",
      page: 1,
      size: asins.length,
      order: { field: "total_units", desc: true },
    },
    returnFields: COMPETITOR_LOOKUP_RETURN_FIELDS,
  }, { signal, runId });
  return extractToolData(result);
}

export function clearAsinDetailRunCacheForTests() {
  asinDetailRequestsByRun.clear();
}

function clearAsinDetailRequest(runId, providerMarketplace, asin) {
  asinDetailRequestsByRun.delete(`${runId}\u0000${providerMarketplace}\u0000${asin}`);
}

function isMinuteRateLimitError(code) {
  return new Set([
    "ERROR_MAXIMUM_ACCESS_PER_MINUTE",
    "MAXIMUM_ACCESS_PER_MINUTE",
    "RATE_LIMITED",
    "TOO_MANY_REQUESTS",
  ]).has(normalizeProviderCode(code));
}

async function waitForRateLimitWindow(waitMs, signal) {
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const error = signal?.reason instanceof Error ? signal.reason : new Error("The request was aborted.");
      error.name ||= "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  throwIfAborted(signal);
}

function failedSourceAsinResult(target, input, collectedAt, failure, audit = {}) {
  const sourceStore = target.sourceStores[0] || {};
  const message = failure.message || "SellerSprite ASIN Detail could not be completed.";
  const errors = target.sourceStores.map((store) => ({
    ...sellerSpriteError(store, failure.code, failure.retryable, target.asin, "sellsprite_detail"),
    message,
  }));
  const item = {
    id: `${input.marketplace}:${target.asin}`,
    marketplace: input.marketplace,
    sourceMarketplace: input.marketplace,
    providerMarketplace: sellerSpriteProviderFor(input.marketplace).providerMarketplace,
    providerMode: sellerSpriteProviderFor(input.marketplace).providerMode,
    parentAsin: null,
    asin: target.asin,
    parentResolved: false,
    sourceAsin: target.asin,
    sourceAsins: [target.asin],
    title: null,
    sellerId: sourceStore.sellerId || null,
    sellerName: sourceStore.sellerName || null,
    currentPrice: null,
    sales30: null,
    sales60: null,
    salesAmount30: null,
    sales30UpdatedAt: null,
    parentSales30: null,
    parentSalesAmount30: null,
    fbaFee: null,
    fbaFeeSource: null,
    primePrice: null,
    deliveryPrice: null,
    listingAvailableAt: null,
    rating: null,
    reviewCount: null,
    hasAPlus: null,
    productWeightKg: null,
    fbaPackageWeightKg: null,
    productDimensionsCm: null,
    fbaPackageDimensionsCm: null,
    fulfillment: null,
    imageUrl: null,
    dataSource: "amazon-store+sellsprite-detail-failed",
    sourceTool: "asin_detail",
    fieldSources: {},
    sourceStores: target.sourceStores,
    collectedAt,
    enrichmentTools: [],
    detailStatus: audit.status || "failed",
    detailErrorCode: failure.code,
    detailError: message,
    detailRetryable: Boolean(failure.retryable),
    detailAttempts: audit.callCount || 0,
    detailRateLimitRetries: audit.rateLimitRetryCount || 0,
    detailRateLimitWaitMs: audit.rateLimitWaitMs || 0,
  };
  item.missingFields = collectSellerSpriteMissingFields(item);
  return {
    item,
    errors,
    cacheHit: Boolean(audit.cacheHit),
    callCount: audit.callCount || 0,
    rateLimitRetryCount: audit.rateLimitRetryCount || 0,
    rateLimitWaitMs: audit.rateLimitWaitMs || 0,
  };
}

function collectSellerSpriteMissingFields(item) {
  const missing = [];
  if (!item.title) missing.push("title");
  if (!Number.isFinite(item.currentPrice)) missing.push("currentPrice");
  if (!Number.isFinite(item.sales30)) missing.push("sales30");
  if (!Number.isFinite(item.sales60)) missing.push("sales60");
  if (!Number.isFinite(item.rating)) missing.push("rating");
  if (!Number.isFinite(item.reviewCount)) missing.push("reviewCount");
  if (typeof item.hasAPlus !== "boolean") missing.push("hasAPlus");
  if (!item.listingAvailableAt) missing.push("listingAvailableAt");
  if (!item.fulfillment) missing.push("fulfillment");
  if (normalizeCandidateFulfillmentMode(item.fulfillment) === "FBA" && !Number.isFinite(item.fbaFee)) missing.push("fbaFee");
  if (!Number.isFinite(item.fbaPackageWeightKg) && !Number.isFinite(item.productWeightKg)) missing.push("weight");
  if (!item.fbaPackageDimensionsCm && !item.productDimensionsCm) missing.push("dimensions");
  return missing;
}

function mergeMissingProductFields(primary, secondary) {
  if (!secondary) return primary;
  const merged = { ...primary };
  const fields = [
    "title", "sellerId", "sellerName", "currentPrice", "sales30", "sales60", "salesAmount30",
    "sales30UpdatedAt", "parentSales30", "parentSalesAmount30", "fbaFee", "fbaFeeSource", "primePrice", "deliveryPrice", "listingAvailableAt",
    "rating", "reviewCount", "hasAPlus", "productWeightKg", "fbaPackageWeightKg",
    "productDimensionsCm", "fbaPackageDimensionsCm", "fulfillment", "imageUrl",
  ];
  const fieldSources = { ...(secondary.fieldSources || {}), ...(primary.fieldSources || {}) };
  for (const field of fields) {
    if (merged[field] !== null && merged[field] !== undefined && merged[field] !== "") continue;
    merged[field] = secondary[field];
    if (secondary.fieldSources?.[field] !== undefined) fieldSources[field] = secondary.fieldSources[field];
  }
  merged.fieldSources = fieldSources;
  return merged;
}

export function selectStoreCandidates(items, _filters, _candidateLimit) {
  return deduplicateSourceAsins(items).sort((left, right) => {
    const reviewDifference = sortableNumber(right.reviewCount) - sortableNumber(left.reviewCount);
    if (reviewDifference) return reviewDifference;
    return String(left.sourceAsin || left.asin || "").localeCompare(String(right.sourceAsin || right.asin || ""));
  });
}

export function selectFinalCandidatesPerStore(items, input) {
  return selectStoreCandidates(items, input.filters, input.candidateLimit);
}

export function matchesCandidateFilters(item, filters) {
  return candidateFilterExclusionReasons(item, filters).length === 0;
}

export function candidateFilterExclusionReasons(item, filters) {
  const reasons = [];
  const detailPending = String(item?.detailStatus || "").toLowerCase() === "pending";
  const monthlySalesBand = filters.monthlySalesBand || "all";
  const effectiveMonthlySales = amazonMonthlySalesValue(item);
  if (effectiveMonthlySales === null || effectiveMonthlySales < 50) {
    reasons.push("MONTHLY_SALES_BELOW_50");
  } else {
    if (monthlySalesBand === "50_to_100" && effectiveMonthlySales >= 100) reasons.push("MONTHLY_SALES_OUTSIDE_50_TO_100");
    if (monthlySalesBand === "100_plus" && effectiveMonthlySales < 100) reasons.push("MONTHLY_SALES_BELOW_100");
  }
  if (filters.minRating !== null && (Number.isFinite(item.rating) ? item.rating < filters.minRating : !detailPending)) reasons.push("RATING_BELOW_MINIMUM");
  if (filters.minReviews !== null && (Number.isFinite(item.reviewCount) ? item.reviewCount < filters.minReviews : !detailPending)) reasons.push("REVIEWS_BELOW_MINIMUM");
  return reasons;
}

function sortableNumber(value) {
  return Number.isFinite(value) ? value : -1;
}

function extractToolData(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.isError === true) {
    throw new ProviderError("SELLSPRITE_UPSTREAM_ERROR");
  }
  let payload;
  if (result.structuredContent !== undefined) {
    if (!isPlainObject(result.structuredContent)) throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    payload = result.structuredContent;
  } else {
    if (!Array.isArray(result.content) || !result.content.length) throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    const blocks = result.content.filter((item) => item?.type === "text" && typeof item.text === "string");
    if (blocks.length !== result.content.length) throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    const parsed = blocks.map((block) => {
      try {
        return JSON.parse(block.text);
      } catch {
        throw new ProviderError("INVALID_PROVIDER_RESPONSE");
      }
    });
    if (parsed.length !== 1 || !isPlainObject(parsed[0])) throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    payload = parsed[0];
  }

  if (typeof payload.code === "string" && payload.code !== "OK") throw new ProviderError(payload.code);
  const data = payload.data === undefined ? payload : payload.data;
  if (!data || typeof data !== "object") throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  return data;
}

export function normalizeSellerSpriteItem(raw, context) {
  if (!isPlainObject(raw)) return null;
  const sourceAsin = normalizeAsin(raw.sourceAsin) || normalizeAsin(raw.asin) || normalizeAsin(context.requestedAsin);
  const explicitParentAsin = normalizeAsin(raw.parentAsin) || normalizeAsin(raw.parent) || normalizeAsin(raw.parent_asin);
  const parentAsin = explicitParentAsin || sourceAsin;
  if (!parentAsin) return null;
  const providerSellerId = normalizeSellerId(raw.sellerId) || normalizeSellerId(raw.seller_id);
  const providerSellerName = cleanOptionalText(firstValue(raw.sellerName, raw.seller_name), 300);
  const sellerId = normalizeSellerId(context.sourceStore.sellerId) || providerSellerId;
  const sellerName = cleanOptionalText(context.sourceStore.sellerName, 300) || providerSellerName;
  const currentPrice = firstNonNegativeNumber(raw.currentPrice, raw.price);
  const childSales30 = firstNonNegativeInteger(raw.amzUnit);
  const parentSales30 = context.sourceTool === "competitor_lookup" ? firstNonNegativeInteger(raw.units) : null;
  const directSales30 = firstNonNegativeInteger(raw.sales30, raw.units30);
  const canUseParentMonthlyData = Boolean(explicitParentAsin && explicitParentAsin === sourceAsin);
  const sales30 = directSales30 ?? childSales30 ?? (context.sourceTool === "competitor_lookup" && canUseParentMonthlyData ? parentSales30 : null);
  const sales60 = firstNonNegativeInteger(raw.sales60, raw.units60);
  const childSalesAmount30 = firstNonNegativeNumber(raw.amzSales);
  const parentSalesAmount30 = context.sourceTool === "competitor_lookup" ? firstNonNegativeNumber(raw.revenue) : null;
  const salesAmount30 = firstNonNegativeNumber(raw.salesAmount30, raw.revenue30)
    ?? childSalesAmount30
    ?? (context.sourceTool === "competitor_lookup" && canUseParentMonthlyData ? parentSalesAmount30 : null);
  const sales30UpdatedAt = normalizeDate(raw.amzUnitDate);
  const fbaFee = firstNonNegativeNumber(raw.fbaFee, context.sourceTool === "competitor_lookup" ? raw.fba : null);
  const primePrice = context.sourceTool === "competitor_lookup" ? firstNonNegativeNumber(raw.primePrice) : null;
  const deliveryPrice = context.sourceTool === "competitor_lookup" ? firstNonNegativeNumber(raw.deliveryPrice) : null;
  const rating = boundedNumber(raw.rating, 0, 5);
  const reviewCount = firstNonNegativeInteger(raw.reviewCount, raw.reviews, raw.ratings);
  const hasAPlus = normalizeBoolean(raw.hasAPlus) ?? normalizeBoolean(raw.badge?.ebc);
  const productWeightKg = normalizeProductWeight(raw);
  const fbaPackageWeightKg = normalizePackageWeight(raw);
  const productDimensionsCm = normalizeProductDimensions(raw);
  const fbaPackageDimensionsCm = normalizePackageDimensions(raw);
  const listingAvailableAt = normalizeDate(raw.availableDate) || normalizeDate(raw.available_date);
  const fulfillment = cleanOptionalText(raw.fulfillment, 50);

  return {
    id: `${context.marketplace}:${parentAsin}`,
    marketplace: context.marketplace,
    sourceMarketplace: context.marketplace,
    providerMarketplace: sellerSpriteProviderFor(context.marketplace).providerMarketplace,
    providerMode: sellerSpriteProviderFor(context.marketplace).providerMode,
    parentAsin,
    asin: parentAsin,
    parentResolved: Boolean(explicitParentAsin),
    sourceAsin,
    sourceAsins: [sourceAsin].filter(Boolean),
    title: cleanOptionalText(raw.title, 2_000),
    sellerId,
    sellerName,
    providerSellerId,
    providerSellerName,
    averagePrice30: null,
    currentPrice,
    sales30,
    sales60,
    salesAmount30,
    sales30UpdatedAt,
    parentSales30,
    parentSalesAmount30,
    fbaFee,
    fbaFeeSource: fbaFee !== null ? context.sourceTool : null,
    primePrice,
    deliveryPrice,
    firstFbaAt: null,
    listingAvailableAt,
    rating,
    reviewCount,
    hasAPlus,
    productWeightKg,
    fbaPackageWeightKg,
    productDimensionsCm,
    fbaPackageDimensionsCm,
    fulfillment,
    imageUrl: normalizeHttpUrl(raw.zoomImageUrl) || normalizeHttpUrl(raw.imageUrl),
    dataSource: "sellsprite-mcp",
    sourceTool: context.sourceTool,
    fieldSources: {
      currentPrice: currentPrice !== null ? context.sourceTool : null,
      sales30: sales30 !== null ? context.sourceTool : null,
      sales60: sales60 !== null ? context.sourceTool : null,
      salesAmount30: salesAmount30 !== null ? context.sourceTool : null,
      sales30UpdatedAt: sales30UpdatedAt ? context.sourceTool : null,
      parentSales30: parentSales30 !== null ? context.sourceTool : null,
      parentSalesAmount30: parentSalesAmount30 !== null ? context.sourceTool : null,
      fbaFee: fbaFee !== null ? context.sourceTool : null,
      primePrice: primePrice !== null ? context.sourceTool : null,
      deliveryPrice: deliveryPrice !== null ? context.sourceTool : null,
      listingAvailableAt: listingAvailableAt ? context.sourceTool : null,
      rating: rating !== null ? context.sourceTool : null,
      reviewCount: reviewCount !== null ? context.sourceTool : null,
      hasAPlus: hasAPlus !== null ? context.sourceTool : null,
      fulfillment: fulfillment ? context.sourceTool : null,
      productWeightKg: productWeightKg !== null ? context.sourceTool : null,
      fbaPackageWeightKg: fbaPackageWeightKg !== null ? context.sourceTool : null,
      productDimensionsCm: productDimensionsCm ? context.sourceTool : null,
      fbaPackageDimensionsCm: fbaPackageDimensionsCm ? context.sourceTool : null,
      imageUrl: (normalizeHttpUrl(raw.zoomImageUrl) || normalizeHttpUrl(raw.imageUrl)) ? context.sourceTool : null,
    },
    sourceStores: [context.sourceStore],
    collectedAt: context.collectedAt,
  };
}

export function deduplicateSourceAsins(items) {
  const bySource = new Map();
  for (const [index, item] of items.entries()) {
    const sourceAsin = normalizeAsin(item.sourceAsin || item.asin);
    const marketplace = cleanOptionalText(item.marketplace || item.sourceMarketplace, 8) || "";
    const key = sourceAsin
      ? `${marketplace}:${sourceAsin}`
      : `missing:${index}:${item.id || ""}`;
    const normalized = sourceAsin
      ? {
        ...item,
        asin: sourceAsin,
        sourceAsin,
        sourceAsins: [sourceAsin],
      }
      : { ...item };
    const existing = bySource.get(key);
    if (!existing) {
      bySource.set(key, normalized);
      continue;
    }
    const preferred = completenessScore(normalized) > completenessScore(existing) ? normalized : existing;
    const secondary = preferred === existing ? normalized : existing;
    const merged = mergeMissingProductFields(preferred, secondary);
    merged.sourceStores = deduplicateSourceStores([...(existing.sourceStores || []), ...(normalized.sourceStores || [])]);
    merged.sourceAsins = sourceAsin ? [sourceAsin] : [...new Set([
      ...(existing.sourceAsins || []),
      ...(normalized.sourceAsins || []),
    ].filter(Boolean))];
    merged.enrichmentTools = [...new Set([
      ...(existing.enrichmentTools || []),
      ...(normalized.enrichmentTools || []),
    ])];
    bySource.set(key, merged);
  }
  return [...bySource.values()];
}

export function deduplicateParentAsins(items) {
  const byParent = new Map();
  for (const item of items) {
    const existing = byParent.get(item.parentAsin);
    if (!existing) {
      byParent.set(item.parentAsin, item);
      continue;
    }
    const preferred = completenessScore(item) > completenessScore(existing) ? item : existing;
    const secondary = preferred === existing ? item : existing;
    const merged = mergeMissingProductFields(preferred, secondary);
    merged.parentResolved = Boolean(existing.parentResolved || item.parentResolved);
    merged.sourceStores = deduplicateSourceStores([...(existing.sourceStores || []), ...(item.sourceStores || [])]);
    merged.sourceAsins = [...new Set([
      ...(existing.sourceAsins || [existing.sourceAsin]),
      ...(item.sourceAsins || [item.sourceAsin]),
    ].filter(Boolean))];
    merged.enrichmentTools = [...new Set([
      ...(existing.enrichmentTools || []),
      ...(item.enrichmentTools || []),
    ])];
    byParent.set(item.parentAsin, merged);
  }
  return [...byParent.values()];
}

function deduplicateSourceStores(stores) {
  const seen = new Set();
  return stores.filter((store) => {
    const key = `${store.storeIndex}:${store.sellerId || ""}:${store.sellerName || ""}:${store.rowNumbers?.join(",") || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function completenessScore(item) {
  return [
    item.title,
    item.sellerId,
    item.sellerName,
    item.currentPrice,
    item.sales30,
    item.salesAmount30,
    item.fbaFee,
    item.listingAvailableAt,
    item.rating,
    item.reviewCount,
    item.productWeightKg,
    item.fbaPackageWeightKg,
    item.productDimensionsCm,
    item.fbaPackageDimensionsCm,
  ].filter((value) => value !== null && value !== undefined).length;
}

function asinDetailFilters(filters) {
  return {
    monthlySalesBand: filters.monthlySalesBand,
    minReviews: filters.minReviews,
    minRating: filters.minRating,
  };
}

export function validateSearchInput(value) {
  if (!isPlainObject(value)) throw new HttpError(400, "INVALID_JSON_BODY", "The JSON body must be an object.");
  const allowedKeys = new Set(["marketplace", "stores", "filters", "useSellerSprite", "runId", "phase", "detailAsins"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(422, "UNKNOWN_SEARCH_FIELD", "The search request contains an unsupported field.");
  }
  const marketplace = validateMarketplace(value.marketplace);
  if (!Array.isArray(value.stores) || !value.stores.length || value.stores.length > MAX_STORES_PER_SEARCH) {
    throw new HttpError(422, "INVALID_STORES", `stores must contain 1 to ${MAX_STORES_PER_SEARCH} entries.`);
  }
  if (value.useSellerSprite !== undefined && typeof value.useSellerSprite !== "boolean") {
    throw new HttpError(422, "INVALID_SELLERSPRITE_MODE", "useSellerSprite must be a boolean.");
  }
  const useSellerSprite = value.useSellerSprite === true;
  const phase = value.phase === undefined || value.phase === null || value.phase === ""
    ? "full"
    : String(value.phase).trim().toLowerCase();
  if (!["full", "discover", "analyze"].includes(phase)) {
    throw new HttpError(422, "INVALID_SEARCH_PHASE", "phase must be full, discover, or analyze.");
  }
  const detailAsinsProvided = Object.prototype.hasOwnProperty.call(value, "detailAsins");
  if (detailAsinsProvided && !Array.isArray(value.detailAsins)) {
    throw new HttpError(422, "INVALID_DETAIL_ASINS", "detailAsins must be an array.");
  }
  const rawDetailAsins = value.detailAsins || [];
  if (detailAsinsProvided && rawDetailAsins.length === 0) {
    throw new HttpError(422, "INVALID_DETAIL_ASINS", "detailAsins must contain at least one ASIN when provided.");
  }
  if (rawDetailAsins.length > MAX_DETAIL_ASINS_PER_SEARCH) {
    throw new HttpError(422, "TOO_MANY_DETAIL_ASINS", `detailAsins exceeds ${MAX_DETAIL_ASINS_PER_SEARCH} entries.`);
  }
  const detailAsins = [...new Set(rawDetailAsins.map((asin) => {
    const normalized = normalizeAsin(asin);
    if (!normalized) throw new HttpError(422, "INVALID_DETAIL_ASIN", "detailAsins contains an invalid ASIN.");
    return normalized;
  }))];
  if (detailAsinsProvided && (phase !== "analyze" || useSellerSprite)) {
    throw new HttpError(422, "INVALID_DETAIL_ASINS_MODE", "detailAsins is available only for Amazon-only analyze requests.");
  }
  const runId = cleanRequiredText(value.runId, 128, "runId");
  if (!/^[A-Za-z0-9._:-]+$/.test(runId)) throw new HttpError(422, "INVALID_RUN_ID", "runId contains unsupported characters.");
  const filters = validateFilters(value.filters);
  const stores = value.stores.map((store, index) => validateSearchStore(store, index, marketplace));
  return { marketplace, stores, filters, useSellerSprite, runId, phase, detailAsins };
}

export function validateAmazonConnectionInput(value) {
  if (!isPlainObject(value)) throw new HttpError(400, "INVALID_JSON_BODY", "The JSON body must be an object.");
  const allowedKeys = new Set(["marketplace", "sellerId"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(422, "UNKNOWN_AMAZON_CHECK_FIELD", "The Amazon connection check contains an unsupported field.");
  }
  const marketplace = validateMarketplace(value.marketplace);
  const sellerId = normalizeSellerId(value.sellerId);
  if (!sellerId) throw new HttpError(422, "INVALID_SELLER_ID", "sellerId is invalid.");
  return { marketplace, sellerId };
}

function validateMarketplace(value) {
  const marketplace = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!SUPPORTED_MARKETPLACES.has(marketplace)) {
    throw new HttpError(422, "UNSUPPORTED_MARKETPLACE", "Only marketplaces AU, US, and NL are supported.");
  }
  return marketplace;
}

function validateSearchStore(value, index, marketplace) {
  if (!isPlainObject(value)) throw new HttpError(422, "INVALID_STORE", `stores[${index}] must be an object.`);
  const storeMarketplace = value.marketplace === undefined || value.marketplace === null || value.marketplace === ""
    ? marketplace
    : validateMarketplace(value.marketplace);
  if (storeMarketplace !== marketplace) {
    throw new HttpError(
      422,
      "MARKETPLACE_MISMATCH",
      `stores[${index}].marketplace must match the top-level marketplace.`,
    );
  }
  const sellerId = value.sellerId === null || value.sellerId === undefined || value.sellerId === ""
    ? null
    : normalizeSellerId(value.sellerId);
  if (value.sellerId && !sellerId) throw new HttpError(422, "INVALID_SELLER_ID", `stores[${index}].sellerId is invalid.`);
  const sellerName = value.sellerName === null || value.sellerName === undefined || value.sellerName === ""
    ? null
    : cleanRequiredText(value.sellerName, 200, `stores[${index}].sellerName`);
  if (value.asins !== undefined && !Array.isArray(value.asins)) {
    throw new HttpError(422, "INVALID_ASINS", `stores[${index}].asins must be an array.`);
  }
  const rawAsins = value.asins || [];
  if (rawAsins.length > 100) throw new HttpError(422, "TOO_MANY_ASINS", `stores[${index}].asins exceeds 100 entries.`);
  const asins = [...new Set(rawAsins.map((asin) => {
    const normalized = normalizeAsin(asin);
    if (!normalized) throw new HttpError(422, "INVALID_ASIN", `stores[${index}] contains an invalid ASIN.`);
    return normalized;
  }))];
  const rowNumbers = Array.isArray(value.rowNumbers)
    ? value.rowNumbers.filter((row) => Number.isInteger(row) && row > 0).slice(0, 1_000)
    : [];
  return { marketplace: storeMarketplace, sellerId, sellerName, asins, rowNumbers };
}

function validateFilters(value) {
  if (value === undefined || value === null) {
    return {
      monthlySalesBand: "all",
      minRating: null,
      minReviews: null,
    };
  }
  if (!isPlainObject(value) || Object.keys(value).some((key) => !ALLOWED_FILTERS.has(key))) {
    throw new HttpError(422, "INVALID_FILTERS", "filters contains an unsupported field.");
  }
  const filters = {};
  for (const key of ALLOWED_FILTERS) {
    const raw = value[key];
    if (raw === undefined || raw === null || raw === "") {
      filters[key] = null;
      continue;
    }
    if (NUMERIC_FILTERS.has(key)) {
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0) throw new HttpError(422, "INVALID_FILTER", `${key} must be a non-negative number.`);
      filters[key] = number;
      continue;
    }
    if (key === "monthlySalesBand") {
      if (typeof raw !== "string" || !MONTHLY_SALES_FILTER_BANDS.has(raw.trim())) {
        throw new HttpError(422, "INVALID_MONTHLY_SALES_BAND", "monthlySalesBand must be all, 50_to_100, or 100_plus.");
      }
      filters[key] = raw.trim();
    }
  }
  if (filters.minRating !== null && filters.minRating > 5) throw new HttpError(422, "INVALID_RATING", "minRating cannot exceed 5.");
  if (filters.minReviews !== null && !Number.isInteger(filters.minReviews)) {
    throw new HttpError(422, "INVALID_REVIEW_COUNT", "minReviews must be an integer.");
  }
  if (filters.monthlySalesBand === null) filters.monthlySalesBand = "all";
  return filters;
}

export function summarizeStoreVisits(visits) {
  const reportedTotals = visits.map((visit) => visit.reportedTotalAsins);
  return {
    discoveredAsins: visits.reduce((total, visit) => total + visit.discoveredAsins, 0),
    reportedTotalAsins: reportedTotals.length > 0
      && reportedTotals.every((value) => Number.isInteger(value) && value >= 0)
      ? reportedTotals.reduce((total, value) => total + value, 0)
      : null,
    notEnumeratedAsins: visits.reduce(
      (total, visit) => total + (Number.isInteger(visit.notEnumeratedAsins) && visit.notEnumeratedAsins > 0 ? visit.notEnumeratedAsins : 0),
      0,
    ),
    omissionReasons: aggregateStoreOmissionReasons(visits),
    visited: visits.filter((visit) => visit.status === "visited" || visit.status === "empty").length,
    empty: visits.filter((visit) => visit.status === "empty").length,
    pending: visits.filter((visit) => visit.status === "pending").length,
    waiting: visits.filter((visit) => visit.status === "waiting").length,
    visitFailed: visits.filter((visit) => visit.status === "failed").length,
    truncated: visits.filter((visit) => visit.truncated).length,
  };
}

function aggregateStoreOmissionReasons(visits) {
  const reasons = new Map();
  visits.forEach((visit) => {
    (visit.omissionReasons || []).forEach((reason) => {
      const code = String(reason?.code || "AMAZON_ASIN_OMISSION");
      const existing = reasons.get(code) || {
        code,
        count: 0,
        countKnown: true,
        affectedStores: 0,
        message: String(reason?.message || "Some source ASINs were not enumerated."),
      };
      existing.affectedStores += 1;
      if (Number.isInteger(reason?.count) && reason.count >= 0) {
        existing.count += reason.count;
      } else {
        existing.countKnown = false;
      }
      reasons.set(code, existing);
    });
  });
  return [...reasons.values()].map((reason) => ({
    ...reason,
    count: reason.countKnown ? reason.count : null,
  }));
}

function emptyStoreAnalysisAudit() {
  return {
    uniqueAsins: 0,
    detailRequested: 0,
    detailCallsStarted: 0,
    detailCacheHits: 0,
    detailReturned: 0,
    detailFailed: 0,
    wideCandidates: 0,
    detailRateLimitWaits: 0,
    rateLimitWaits: 0,
    rateLimitRetries: 0,
    rateLimitWaitMs: 0,
  };
}

function sellerSpriteError(store, code, retryable, asin = null, stage = "sellsprite") {
  return {
    storeIndex: store.storeIndex,
    sellerId: store.sellerId,
    sellerName: store.sellerName,
    rowNumbers: store.rowNumbers,
    asin,
    code,
    message: code === "INVALID_PROVIDER_ITEM"
      ? "SellerSprite ASIN Detail returned an item without a valid ASIN."
      : "SellerSprite could not complete this ASIN Detail query.",
    retryable,
    stage,
  };
}

function amazonStoreError(store, error) {
  const code = error instanceof AmazonStoreError
    ? normalizeProviderCode(error.code)
    : "AMAZON_SESSION_FAILED";
  const nonRetryable = new Set([
    "INVALID_SELLER_ID",
    "UNSUPPORTED_MARKETPLACE",
    "AMAZON_URL_REJECTED",
    "AMAZON_SESSION_CLOSED",
    "AMAZON_PAGINATION_NO_PROGRESS",
  "AMAZON_PAGINATION_LOOP",
    "AMAZON_STORE_TOTAL_PAGE_LIMIT_REACHED",
  ]);
  const upstreamMessage = cleanOptionalText(error?.message, 300);
  const message = code === "AMAZON_ACCESS_CHALLENGE"
    ? "Amazon requested an access verification while visiting this store."
    : code === "INVALID_SELLER_ID"
      ? "The Amazon seller ID is invalid."
      : upstreamMessage || "Amazon could not complete this store visit.";
  return {
    storeIndex: store.storeIndex,
    sellerId: store.sellerId,
    sellerName: store.sellerName,
    rowNumbers: store.rowNumbers,
    asin: null,
    code,
    message,
    retryable: !nonRetryable.has(code),
    stage: "amazon_store",
  };
}

function amazonProductError(store, asin, error) {
  const base = amazonStoreError(store, error);
  const code = base.code === "AMAZON_SESSION_FAILED" ? "AMAZON_PRODUCT_DETAIL_FAILED" : base.code;
  const nonRetryable = new Set([
    "INVALID_ASIN",
    "UNSUPPORTED_MARKETPLACE",
    "AMAZON_URL_REJECTED",
    "AMAZON_PRODUCT_REDIRECT_REJECTED",
    "AMAZON_PRODUCT_ASIN_MISMATCH",
    "AMAZON_INVALID_PRODUCT_PAGE",
    "AMAZON_PRODUCT_INVALID",
    "AMAZON_RESPONSE_TOO_LARGE",
    "AMAZON_HTTP_400",
    "AMAZON_HTTP_404",
    "AMAZON_HTTP_410",
  ]);
  return {
    ...base,
    asin,
    code,
    message: cleanOptionalText(error?.message, 500) || "Amazon could not complete this product detail visit.",
    retryable: base.retryable && !nonRetryable.has(code),
    stage: "amazon_product",
  };
}

function providerErrorCode(error) {
  if (error instanceof ProviderError) return error.code;
  const code = normalizeProviderCode(error?.code);
  return new Set([
    "LOCAL_PERSISTENCE_FAILED",
    "ERROR_MAXIMUM_ACCESS_PER_MINUTE",
    "MAXIMUM_ACCESS_PER_MINUTE",
    "RATE_LIMITED",
    "TOO_MANY_REQUESTS",
    "SELLSPRITE_SESSION_LOST",
    "SELLSPRITE_CONNECT_REQUIRED",
    "SELLSPRITE_AUTH_REQUIRED",
    "NOT_CONNECTED",
    "NOT_INITIALIZED",
    "CONNECTION_CLOSED",
    "CLIENT_HTTP_AUTHENTICATION",
    "CLIENT_HTTP_FORBIDDEN",
  ]).has(code) ? code : "SELLSPRITE_REQUEST_FAILED";
}

function isRetryableProviderError(error) {
  const nonRetryable = new Set(["INVALID_PROVIDER_ITEM", "INVALID_ASIN", "NOT_FOUND", "ERROR_PARAM"]);
  return !nonRetryable.has(providerErrorCode(error));
}

async function mapWithConcurrency(values, limit, worker, signal) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < values.length) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, runWorker));
  return results;
}

function callSellerSpriteToolLimited(name, args, options = {}) {
  return sellerSpriteSemaphore.run(
    () => callSellerSpriteTool(name, args, options),
    { signal: options.signal },
  );
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  throw error;
}

function createSemaphore(limit) {
  let active = 0;
  const queue = [];

  function dispatch() {
    while (active < limit && queue.length) {
      const entry = queue.shift();
      if (entry.cancelled) continue;
      entry.started = true;
      entry.cleanup();
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          dispatch();
        });
    }
  }

  return {
    run(task, { signal } = {}) {
      try {
        throwIfAborted(signal);
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        const entry = {
          task,
          resolve,
          reject,
          started: false,
          cancelled: false,
          cleanup: () => {},
        };
        if (signal) {
          const abort = () => {
            if (entry.started || entry.cancelled) return;
            entry.cancelled = true;
            entry.cleanup();
            reject(signal.reason instanceof Error ? signal.reason : new Error("The request was aborted."));
            dispatch();
          };
          entry.cleanup = () => signal.removeEventListener("abort", abort);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }
        queue.push(entry);
        dispatch();
      });
    },
  };
}

function normalizeProductWeight(raw) {
  const explicit = nonNegativeNumber(raw.productWeightKg);
  if (explicit !== null) return explicit;
  const grams = nonNegativeNumber(raw.weightGram);
  if (grams !== null) return roundMeasure(grams / 1_000);
  return parseWeightKg(raw.weight);
}

function normalizePackageWeight(raw) {
  const explicit = nonNegativeNumber(raw.fbaPackageWeightKg);
  if (explicit !== null) return explicit;
  const grams = nonNegativeNumber(firstValue(raw.pkgWeightGram, raw.packageWeightGram));
  if (grams !== null) return roundMeasure(grams / 1_000);
  return parseWeightKg(firstValue(raw.pkgWeight, raw.packageWeight));
}

function parseWeightKg(value) {
  if (typeof value !== "string") return null;
  const match = value.normalize("NFKC").trim().match(/(\d+(?:\.\d+)?)\s*(kg|kilograms?|g|grams?|lb|lbs|pounds?|oz|ounces?)/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (unit === "kg" || unit.startsWith("kilogram")) return roundMeasure(amount);
  if (unit === "g" || unit.startsWith("gram")) return roundMeasure(amount / 1_000);
  if (unit === "lb" || unit === "lbs" || unit.startsWith("pound")) return roundMeasure(amount * 0.45359237);
  return roundMeasure(amount * 0.028349523125);
}

function normalizeProductDimensions(raw) {
  return normalizeDimensionsCm(raw.productDimensionsCm)
    || normalizeDimensionsCm(raw.dimension)
    || normalizeDimensionsCm(raw.dimensions);
}

function normalizePackageDimensions(raw) {
  return normalizeDimensionsCm(raw.fbaPackageDimensionsCm)
    || normalizeDimensionsCm(raw.pkgDimensions)
    || normalizeDimensionsCm(raw.packageDimensions);
}

function normalizeDimensionsCm(value) {
  if (Array.isArray(value)) {
    const dimensions = value.slice(0, 3).map(Number);
    return dimensions.length === 3 && dimensions.every((number) => Number.isFinite(number) && number > 0)
      ? dimensions.map(roundMeasure)
      : null;
  }
  if (isPlainObject(value)) {
    const dimensions = [value.length, value.width, value.height].map(Number);
    if (!dimensions.every((number) => Number.isFinite(number) && number > 0)) return null;
    const unit = String(value.unit || "cm").toLowerCase();
    const factor = unit === "mm" ? 0.1 : unit === "in" || unit === "inch" || unit === "inches" ? 2.54 : unit === "cm" ? 1 : null;
    return factor ? dimensions.map((number) => roundMeasure(number * factor)) : null;
  }
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim();
  const numbers = text.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
  if (!numbers || numbers.length !== 3 || numbers.some((number) => !Number.isFinite(number) || number <= 0)) return null;
  const factor = /\bmm\b/i.test(text) ? 0.1
    : /\b(?:in|inch|inches)\b|[\u2033"]/i.test(text) ? 2.54
      : /\bcm\b/i.test(text) ? 1 : null;
  return factor ? numbers.map((number) => roundMeasure(number * factor)) : null;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || /^y(?:es)?$/i.test(String(value))) return true;
  if (value === 0 || value === "0" || /^n(?:o)?$/i.test(String(value))) return false;
  return null;
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === "") return null;
  let timestamp;
  if (typeof value === "number" && Number.isFinite(value)) timestamp = value > 1e12 ? value : value * 1_000;
  else timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

function isValidDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function normalizeDateOnly(value) {
  return normalizeDate(value)?.slice(0, 10) || null;
}

function normalizeCandidateFulfillmentMode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (/(?:FBM|MFN|MERCHANT)/.test(normalized)) return "FBM";
  if (/(?:FBA|AMZ|AMAZON)/.test(normalized)) return "FBA";
  return null;
}

function normalizeHttpUrl(value) {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeAsin(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(normalized) ? normalized : null;
}

function normalizeSellerId(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{8,20}$/.test(normalized) ? normalized : null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "") ?? null;
}

function nonNegativeNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function firstNonNegativeNumber(...values) {
  for (const value of values) {
    const number = nonNegativeNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function firstNonNegativeInteger(...values) {
  const number = firstNonNegativeNumber(...values);
  return number === null ? null : Math.round(number);
}

function boundedNumber(value, minimum, maximum) {
  const number = nonNegativeNumber(value);
  return number !== null && number >= minimum && number <= maximum ? number : null;
}

function roundMeasure(value) {
  return Math.round((value + Number.EPSILON) * 1_000) / 1_000;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function cleanOptionalText(value, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  const text = decodeHTML(String(value)).normalize("NFC").trim().replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ");
  if (!text || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
  return text;
}

function cleanRequiredText(value, maxLength, field) {
  const text = cleanOptionalText(value, maxLength);
  if (!text) throw new HttpError(422, "INVALID_TEXT_FIELD", `${field} is required and must contain valid text.`);
  return text;
}

function validateProcurementTaskId(value) {
  const taskId = String(value || "");
  // 兼容两种任务 ID：原版采购助手的 task_ 前缀格式，以及本地桥接服务的 UUID 格式。
  const isLegacyFormat = /^task_[A-Za-z0-9][A-Za-z0-9_-]{0,122}$/.test(taskId);
  const isUuidFormat = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(taskId);
  if (!isLegacyFormat && !isUuidFormat) {
    throw new HttpError(422, "INVALID_PROCUREMENT_TASK_ID", "The 1688 procurement task ID is invalid.");
  }
  return taskId;
}

function normalizeProviderCode(value) {
  const normalized = String(value || "SELLSPRITE_UPSTREAM_ERROR").toUpperCase().replace(/[^A-Z0-9_]+/g, "_").slice(0, 80);
  return normalized || "SELLSPRITE_UPSTREAM_ERROR";
}

async function resolveDefaultStoreFile() {
  const configured = process.env.SCOUT_DEFAULT_STORE_FILE;
  if (configured) {
    return {
      filePath: path.resolve(configured),
      marketplace: validateMarketplace(process.env.SCOUT_DEFAULT_MARKETPLACE || "NL"),
    };
  }
  const home = process.env.USERPROFILE || os.homedir();
  const candidates = [
    { filePath: path.join(home, "Desktop", "店铺.xlsx"), marketplace: "NL" },
    { filePath: path.join(home, "Desktop", "竞品店铺.xlsx"), marketplace: "AU" },
  ];
  for (const candidate of candidates) {
    try {
      const details = await stat(candidate.filePath);
      if (details.isFile()) return candidate;
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") return candidate;
    }
  }
  return candidates[0];
}

function sellerSpriteProviderFor(marketplace) {
  const sourceMarketplace = String(marketplace || "").trim().toUpperCase();
  return sourceMarketplace === "NL"
    ? { sourceMarketplace, providerMarketplace: "DE", providerMode: "proxy" }
    : { sourceMarketplace, providerMarketplace: sourceMarketplace, providerMode: "native" };
}

async function readJsonBody(request, maximumBytes = JSON_BODY_LIMIT) {
  const buffer = await readBody(request, maximumBytes);
  if (!buffer.length) throw new HttpError(400, "EMPTY_JSON_BODY", "A JSON request body is required.");
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

async function readBody(request, maximumBytes) {
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
    throw new HttpError(415, "CONTENT_ENCODING_NOT_SUPPORTED", "Compressed request bodies are not accepted.");
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    request.resume();
    throw new HttpError(413, "BODY_TOO_LARGE", "The request body exceeds the local safety limit.");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximumBytes) {
      request.resume();
      throw new HttpError(413, "BODY_TOO_LARGE", "The request body exceeds the local safety limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function requireContentType(request, allowedTypes) {
  const type = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (!allowedTypes.includes(type)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", `Content-Type must be ${allowedTypes.join(" or ")}.`);
  }
}

function requireMethod(request, methods) {
  if (!methods.includes(request.method)) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", `Method ${request.method || "UNKNOWN"} is not allowed.`);
  }
}

function singleHeader(value) {
  return Array.isArray(value) ? null : typeof value === "string" ? value : null;
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://m.media-amazon.com https://images-na.ssl-images-amazon.com https://images-eu.ssl-images-amazon.com https://images-fe.ssl-images-amazon.com https://images-cn.ssl-images-amazon.com https://*.alicdn.com https://*.1688.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function normalizeHttpError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof ProcurementDependencyError) return new HttpError(error.status, error.code, error.message);
  if (error instanceof Procurement1688Error) {
    const taskId = /^(?:task_[A-Za-z0-9][A-Za-z0-9_-]{0,122}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(String(error.details?.taskId || ""))
      ? String(error.details.taskId)
      : null;
    return new HttpError(error.status, error.code, error.message, taskId ? { taskId } : null);
  }
  if (error instanceof RunFolderOpenError) return new HttpError(error.status, error.code, error.message);
  if (error instanceof XlsxExportError) return new HttpError(error.status, error.code, error.message);
  if (error instanceof ExportFileStoreError) return new HttpError(error.status, error.code, error.message);
  if (error instanceof PersistenceStoreError) return new HttpError(error.status, error.code, error.message);
  if (error?.code === 'RUN_ARCHIVED') return new HttpError(409, error.code, error.message);
  if (String(error?.code || '').startsWith('SUPPLIER_')) return new HttpError(error.status || 409, error.code, error.message);
  if (error instanceof StoreListError) {
    const statusByCode = {
      FILE_TOO_LARGE: 413,
      UNSUPPORTED_FILE_TYPE: 415,
      EMPTY_FILE: 400,
      INVALID_XLSX: 422,
    };
    return new HttpError(statusByCode[error.code] || 422, error.code, error.message);
  }
  return new HttpError(500, "INTERNAL_ERROR", "The local server could not complete the request.");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SCOUT_PORT must be an integer from 1 to 65535.");
  return port;
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (drainTimer) clearTimeout(drainTimer);
  process.stdout.write(`Scout Amazon local server closing (${signal}).\n`);
  const forceTimer = setTimeout(() => process.exit(1), 5_000);
  forceTimer.unref?.();
  await amazonCollector.close();
  await supplierPipeline.close();
  await persistenceStore.writeQueue;
  await new Promise((resolve) => server.close(resolve));
  await resetSellerSpriteClient();
  asinDetailRequestsByRun.clear();
  clearTimeout(forceTimer);
  process.exitCode = 0;
}
