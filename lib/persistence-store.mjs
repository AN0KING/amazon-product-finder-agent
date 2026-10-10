import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeAmazonCollectionProducts } from "./amazon-collection-merge.mjs";
import { recomputeProductProfit } from "./product-profit-state.mjs";

const SCHEMA_VERSION = 1;
// A resumed task can revalidate thousands of ASINs in 20-item batches.
// Retain earlier collection audits while allowing several full refresh passes.
const MAX_SEARCH_BATCHES_PER_RUN = 1_000;
const MAX_ASIN_DETAIL_BYTES = 512 * 1024;
const MAX_COMPETITOR_LOOKUP_ASINS = 40;
const MAX_COMPETITOR_LOOKUP_ITEM_BYTES = 256 * 1024;
const MAX_COMPETITOR_LOOKUP_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_AMAZON_STORE_CHECKPOINTS = 1_000;
const MAX_AMAZON_STORE_ASINS = 10_000;
const MAX_AMAZON_STORE_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PRODUCT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,240}$/;
const CSS_TOKEN_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export class PersistenceStoreError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "PersistenceStoreError";
    this.code = code;
    this.status = status;
  }
}

export class PersistenceStore {
  constructor({ directory = defaultDataDirectory() } = {}) {
    this.directory = path.resolve(directory);
    this.runsDirectory = path.join(this.directory, "runs");
    this.indexPath = path.join(this.directory, "state.json");
    this.index = emptyIndex();
    this.writeQueue = Promise.resolve();
    this.snapshotListeners = new Set();
    this.readyPromise = this.load();
  }

  async ready() {
    await this.readyPromise;
  }

  getTotalToolCallCount() {
    return this.index.totalSellerSpriteCalls;
  }

  getRunToolCalls(runId) {
    const entry = this.index.runToolCalls[runId];
    return entry ? cloneJson(entry) : { total: 0, byTool: {} };
  }

  async getAmazonCollection(runId) {
    assertRunId(runId);
    await this.ready();
    await this.writeQueue;
    const document = await this.readRunFile(runId);
    return cloneJson(document?.amazonCollection || { job: null, items: {} });
  }

  async getActiveAmazonCollection() {
    await this.ready();
    await this.writeQueue;
    const runId = this.index.amazonCollectionRunId;
    if (!runId) return null;
    const document = await this.readRunFile(runId);
    return document?.amazonCollection?.job
      ? { runId, ...cloneJson(document.amazonCollection) }
      : null;
  }

  async updateAmazonCollection(runId, updater, { activate = false } = {}) {
    assertRunId(runId);
    if (typeof updater !== "function") throw new PersistenceStoreError("INVALID_AMAZON_COLLECTION_UPDATE", "The collection updater must be a function.");
    await this.ready();
    return this.enqueue(async () => {
      const document = await this.readRunFile(runId) || emptyRunDocument(runId);
      const existing = document.amazonCollection || { job: null, items: {} };
      const draft = cloneJson(existing);
      const returned = await updater(draft);
      const next = returned === undefined ? draft : returned;
      const collection = normalizeAmazonCollection(next, existing);
      document.amazonCollection = collection;
      if (document.snapshot) {
        document.snapshot = projectAmazonCollectionSnapshot(document.snapshot, collection);
        document.snapshot.savedAt = new Date().toISOString();
      }
      document.updatedAt = new Date().toISOString();
      await this.writeRunFile(runId, document);
      this.upsertSummary(summaryFromDocument(document));
      if (activate) this.index.amazonCollectionRunId = runId;
      this.touchIndex();
      await this.persistIndex();
      this.notifySnapshotUpdated(runId);
      return cloneJson(collection);
    });
  }

  async saveAmazonConnectionCheck(value) {
    const check = normalizeAmazonConnectionCheck(value);
    if (!check) {
      throw new PersistenceStoreError("INVALID_AMAZON_CONNECTION_CHECK", "The Amazon connection check is invalid.");
    }
    return this.enqueue(async () => {
      this.index.amazonConnectionChecks[check.marketplace] = check;
      this.touchIndex();
      await this.persistIndex();
      return cloneJson(check);
    });
  }

  async getAmazonStoreCheckpoints(runId) {
    assertRunId(runId);
    await this.ready();
    await this.writeQueue;
    const document = await this.readRunFile(runId);
    return isPlainObject(document?.amazonStoreCheckpoints)
      ? cloneJson(document.amazonStoreCheckpoints)
      : {};
  }

  async saveAmazonStoreCheckpoint(runId, value) {
    assertRunId(runId);
    const checkpoint = normalizeAmazonStoreCheckpoint(value);
    const key = amazonStoreCheckpointKey(checkpoint.marketplace, checkpoint.sellerId);
    if (Buffer.byteLength(JSON.stringify(checkpoint), "utf8") > MAX_AMAZON_STORE_CHECKPOINT_BYTES) {
      throw new PersistenceStoreError(
        "AMAZON_STORE_CHECKPOINT_TOO_LARGE",
        "The Amazon store checkpoint is too large to save.",
        413,
      );
    }
    return this.enqueue(async () => {
      const document = await this.readRunFile(runId) || emptyRunDocument(runId);
      const checkpoints = isPlainObject(document.amazonStoreCheckpoints)
        ? document.amazonStoreCheckpoints
        : {};
      if (!Object.hasOwn(checkpoints, key) && Object.keys(checkpoints).length >= MAX_AMAZON_STORE_CHECKPOINTS) {
        throw new PersistenceStoreError(
          "TOO_MANY_AMAZON_STORE_CHECKPOINTS",
          `A run can save at most ${MAX_AMAZON_STORE_CHECKPOINTS} Amazon store checkpoints.`,
          413,
        );
      }
      document.amazonStoreCheckpoints = { ...checkpoints, [key]: checkpoint };
      document.marketplace ||= checkpoint.marketplace;
      document.startedAt ||= checkpoint.updatedAt;
      document.updatedAt = new Date().toISOString();
      await this.writeRunFile(runId, document);
      return cloneJson(checkpoint);
    });
  }

  async getAsinDetailResult(runId, { marketplace, asin }) {
    assertRunId(runId);
    const key = asinDetailKey(marketplace, asin);
    await this.ready();
    await this.writeQueue;
    const document = await this.readRunFile(runId);
    const entry = document?.asinDetails?.[key];
    return entry?.status === "success" && isPlainObject(entry.data)
      ? cloneJson(entry)
      : null;
  }

  async getAsinDetailResults(runId) {
    assertRunId(runId);
    await this.ready();
    await this.writeQueue;
    const document = await this.readRunFile(runId);
    return isPlainObject(document?.asinDetails) ? cloneJson(document.asinDetails) : {};
  }

  async saveAsinDetailResult(runId, { marketplace, asin, data, collectedAt = new Date().toISOString() }) {
    assertRunId(runId);
    const key = asinDetailKey(marketplace, asin);
    if (!isPlainObject(data)) {
      throw new PersistenceStoreError("INVALID_ASIN_DETAIL", "The ASIN detail result must be an object.");
    }
    const safeData = cloneJson(data);
    if (Buffer.byteLength(JSON.stringify(safeData), "utf8") > MAX_ASIN_DETAIL_BYTES) {
      throw new PersistenceStoreError("ASIN_DETAIL_TOO_LARGE", "The ASIN detail result is too large to checkpoint.", 413);
    }
    return this.enqueue(async () => {
      const document = await this.readRunFile(runId) || emptyRunDocument(runId);
      document.asinDetails ||= {};
      document.asinDetails[key] = {
        status: "success",
        marketplace: String(marketplace).trim().toUpperCase(),
        asin: String(asin).trim().toUpperCase(),
        collectedAt,
        data: safeData,
      };
      document.updatedAt = new Date().toISOString();
      await this.writeRunFile(runId, document);
      return cloneJson(document.asinDetails[key]);
    });
  }

  async getCompetitorLookupResults(runId) {
    assertRunId(runId);
    await this.ready();
    await this.writeQueue;
    const document = await this.readRunFile(runId);
    return isPlainObject(document?.competitorLookups) ? cloneJson(document.competitorLookups) : {};
  }

  async saveCompetitorLookupBatch(
    runId,
    { marketplace, month, requestedAsins, items, collectedAt = new Date().toISOString() },
  ) {
    assertRunId(runId);
    const normalizedMarketplace = normalizeCompetitorMarketplace(marketplace);
    const normalizedMonth = normalizeCompetitorMonth(month);
    const normalizedCollectedAt = normalizeCollectedAt(collectedAt);
    if (!Array.isArray(requestedAsins) || requestedAsins.length < 1) {
      throw new PersistenceStoreError(
        "INVALID_COMPETITOR_LOOKUP_ASINS",
        "requestedAsins must contain at least one ASIN.",
      );
    }
    if (requestedAsins.length > MAX_COMPETITOR_LOOKUP_ASINS) {
      throw new PersistenceStoreError(
        "TOO_MANY_COMPETITOR_LOOKUP_ASINS",
        `requestedAsins must contain at most ${MAX_COMPETITOR_LOOKUP_ASINS} ASINs.`,
      );
    }
    const normalizedAsins = [...new Set(requestedAsins.map(normalizeCompetitorAsin))];
    if (!Array.isArray(items) || items.length > MAX_COMPETITOR_LOOKUP_ASINS) {
      throw new PersistenceStoreError(
        "INVALID_COMPETITOR_LOOKUP_ITEMS",
        `items must be an array containing at most ${MAX_COMPETITOR_LOOKUP_ASINS} entries.`,
      );
    }

    const requestedSet = new Set(normalizedAsins);
    const returnedItems = new Map();
    for (const item of items) {
      if (!isPlainObject(item)) {
        throw new PersistenceStoreError(
          "INVALID_COMPETITOR_LOOKUP_ITEM",
          "Every competitor lookup item must be an object.",
        );
      }
      const asin = normalizeCompetitorAsin(item.asin);
      if (!requestedSet.has(asin)) {
        throw new PersistenceStoreError(
          "COMPETITOR_LOOKUP_UNREQUESTED_ASIN",
          "A competitor lookup item contains an ASIN that was not requested.",
        );
      }
      if (returnedItems.has(asin)) {
        throw new PersistenceStoreError(
          "DUPLICATE_COMPETITOR_LOOKUP_ASIN",
          "A competitor lookup response contains the same ASIN more than once.",
        );
      }
      const safeItem = cloneJson({ ...item, asin });
      if (Buffer.byteLength(JSON.stringify(safeItem), "utf8") > MAX_COMPETITOR_LOOKUP_ITEM_BYTES) {
        throw new PersistenceStoreError(
          "COMPETITOR_LOOKUP_ITEM_TOO_LARGE",
          "A competitor lookup item is too large to checkpoint.",
          413,
        );
      }
      returnedItems.set(asin, safeItem);
    }

    const records = Object.fromEntries(normalizedAsins.map((asin) => {
      const data = returnedItems.get(asin) || null;
      return [competitorLookupKey(normalizedMarketplace, normalizedMonth, asin), {
        status: data ? "success" : "empty",
        marketplace: normalizedMarketplace,
        month: normalizedMonth,
        asin,
        collectedAt: normalizedCollectedAt,
        data,
      }];
    }));
    if (Buffer.byteLength(JSON.stringify(records), "utf8") > MAX_COMPETITOR_LOOKUP_BATCH_BYTES) {
      throw new PersistenceStoreError(
        "COMPETITOR_LOOKUP_BATCH_TOO_LARGE",
        "The competitor lookup batch is too large to checkpoint.",
        413,
      );
    }

    return this.enqueue(async () => {
      const document = await this.readRunFile(runId) || emptyRunDocument(runId);
      document.competitorLookups = {
        ...(isPlainObject(document.competitorLookups) ? document.competitorLookups : {}),
        ...records,
      };
      document.updatedAt = new Date().toISOString();
      await this.writeRunFile(runId, document);
      return cloneJson(records);
    });
  }

  async recordToolCall({ runId = null, tool = "unknown" } = {}) {
    if (runId !== null) assertRunId(runId);
    const toolName = cleanShortText(tool, 80) || "unknown";
    return this.enqueue(async () => {
      this.index.totalSellerSpriteCalls += 1;
      if (runId) {
        const current = this.index.runToolCalls[runId] || { total: 0, byTool: {} };
        current.total += 1;
        current.byTool[toolName] = (current.byTool[toolName] || 0) + 1;
        this.index.runToolCalls[runId] = current;
        const summary = this.index.runs.find((item) => item.id === runId);
        if (summary) {
          summary.sellerSpriteCalls = current.total;
          summary.sellerSpriteCallsByTool = { ...current.byTool };
        }
      }
      this.touchIndex();
      await this.persistIndex();
      return {
        total: this.index.totalSellerSpriteCalls,
        run: runId ? this.getRunToolCalls(runId) : { total: 0, byTool: {} },
      };
    });
  }

  async appendSearchBatch(runId, batch) {
    assertRunId(runId);
    if (!isPlainObject(batch)) throw new PersistenceStoreError("INVALID_SEARCH_BATCH", "The search batch must be an object.");
    const safeBatch = cloneJson(batch);
    return this.enqueue(async () => {
      const existing = await this.readRunFile(runId) || emptyRunDocument(runId);
      if (safeBatch.phase === "discover") {
        existing.amazonDiscoverySummary = compactAmazonDiscoverySummary(safeBatch);
        existing.marketplace ||= cleanMarketplace(safeBatch.marketplace);
        existing.startedAt ||= safeBatch.collectedAt || new Date().toISOString();
        existing.status = existing.snapshot ? existing.status : "collecting";
        existing.updatedAt = new Date().toISOString();
        existing.sellerSprite = this.getRunToolCalls(runId);
        await this.writeRunFile(runId, existing);
        this.upsertSummary(summaryFromDocument(existing));
        this.index.latestRunId = runId;
        this.touchIndex();
        await this.persistIndex();
        return summaryFromDocument(existing);
      }
      const searchBatches = Array.isArray(existing.searchBatches) ? existing.searchBatches : [];
      if (searchBatches.length >= MAX_SEARCH_BATCHES_PER_RUN) {
        throw new PersistenceStoreError("TOO_MANY_SEARCH_BATCHES", "The run contains too many saved search batches.", 413);
      }
      existing.searchBatches = [...searchBatches, safeBatch];
      existing.marketplace ||= cleanMarketplace(safeBatch.marketplace);
      existing.startedAt ||= safeBatch.collectedAt || new Date().toISOString();
      existing.status = existing.snapshot
        ? existing.status
        : safeBatch.status === "failed" ? "failed" : safeBatch.status === "completed" ? "collected" : "collecting";
      existing.updatedAt = new Date().toISOString();
      existing.sellerSprite = this.getRunToolCalls(runId);
      await this.writeRunFile(runId, existing);
      this.upsertSummary(summaryFromDocument(existing));
      this.index.latestRunId = runId;
      this.touchIndex();
      await this.persistIndex();
      return summaryFromDocument(existing);
    });
  }

  async saveSnapshot(value) {
    const submittedSnapshot = validateSnapshot(value);
    const runId = submittedSnapshot.runState.id;
    return this.enqueue(async () => {
      const existing = await this.readRunFile(runId) || emptyRunDocument(runId);
      const supplierPipeline = existing.snapshot?.runState?.supplier1688Pipeline;
      if (supplierPipeline?.owner === "server") {
        if (Number(submittedSnapshot.runState?.supplier1688Pipeline?.revision || 0) < Number(supplierPipeline.revision || 0)) {
          throw new PersistenceStoreError("STALE_SUPPLIER_SNAPSHOT", "后台报价与利润已更新，请同步最新商品后再保存。", 409);
        }
        if (["queued", "running", "cooldown"].includes(supplierPipeline.status)) {
          throw new PersistenceStoreError("SUPPLIER_PIPELINE_BUSY", "后台正在匹配并计算利润，请暂停匹配后再编辑。", 409);
        }
      }
      assertCurrentAmazonCollectionSnapshot(existing.amazonCollection, submittedSnapshot);
      assertCurrentAmazonPriceSnapshot(existing.snapshot, submittedSnapshot);
      const snapshot = projectAmazonCollectionSnapshot(
        mergeSnapshotProducts(existing.snapshot, submittedSnapshot), existing.amazonCollection,
      );
      const now = new Date().toISOString();
      const document = {
        ...existing,
        id: runId,
        schemaVersion: SCHEMA_VERSION,
        marketplace: cleanMarketplace(snapshot.runState.marketplace),
        startedAt: snapshot.runState.startedAt || existing.startedAt || now,
        completedAt: snapshot.runState.completedAt || null,
        status: snapshotStatus(snapshot.runState),
        updatedAt: now,
        sellerSprite: this.getRunToolCalls(runId),
        snapshot,
      };
      await this.writeRunFile(runId, document);
      this.upsertSummary(summaryFromDocument(document));
      this.index.latestRunId = runId;
      this.touchIndex();
      await this.persistIndex();
      return {
        summary: summaryFromDocument(document),
        runs: cloneJson(this.index.runs),
        totalSellerSpriteCalls: this.index.totalSellerSpriteCalls,
      };
    });
  }

  async getOverview() {
    await this.ready();
    await this.writeQueue;
    const candidateIds = [
      this.index.supplierPipelineRunId,
      this.index.latestRunId,
      ...this.index.runs.filter((run) => run.hasSnapshot).map((run) => run.id),
    ].filter((runId, index, values) => RUN_ID_PATTERN.test(String(runId || "")) && values.indexOf(runId) === index);
    let latestSavedRunId = null;
    let latestDocument = null;
    for (const runId of candidateIds) {
      try {
        const document = await this.readRunFile(runId);
        if (!document?.snapshot) continue;
        latestSavedRunId = runId;
        latestDocument = document;
        break;
      } catch (error) {
        if (!(error instanceof PersistenceStoreError) || error.code !== "RUN_READ_FAILED") throw error;
      }
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: this.index.updatedAt,
      totalSellerSpriteCalls: this.index.totalSellerSpriteCalls,
      amazonConnectionChecks: cloneJson(this.index.amazonConnectionChecks),
      latestRunId: latestSavedRunId,
      runs: cloneJson(this.index.runs),
      latestRun: clientSnapshotFromDocument(latestDocument),
    };
  }

  async getRunSnapshot(runId) {
    assertRunId(runId);
    await this.ready();
    await this.writeQueue;
    const document = await this.readRunFile(runId);
    return clientSnapshotFromDocument(document);
  }

  async getActiveSupplierRunId() {
    await this.ready();
    await this.writeQueue;
    return this.index.supplierPipelineRunId || null;
  }

  onSnapshotUpdated(listener) {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  notifySnapshotUpdated(runId) {
    for (const listener of this.snapshotListeners) {
      try { listener({ runId }); } catch { /* A closed browser cannot interrupt persistence. */ }
    }
  }

  async setActiveSupplierRunId(runId) {
    if (runId !== null) assertRunId(runId);
    await this.ready();
    return this.enqueue(async () => {
      this.index.supplierPipelineRunId = runId;
      if (runId) this.index.latestRunId = runId;
      this.touchIndex();
      await this.persistIndex();
    });
  }

  // Mutate the latest snapshot inside the same serialized write queue as the
  // Amazon collector. A returned quote can never replace newer manual fields.
  async updateSupplierSnapshot(runId, updater) {
    assertRunId(runId);
    await this.ready();
    return this.enqueue(async () => {
      const document = await this.readRunFile(runId);
      if (!document?.snapshot) throw new PersistenceStoreError("RUN_NOT_FOUND", "未找到已保存的匹配批次。", 404);
      const draft = projectAmazonCollectionSnapshot(document.snapshot, document.amazonCollection);
      const returned = await updater(draft);
      const next = returned === undefined ? draft : returned;
      if (next?.runState?.id !== runId) throw new PersistenceStoreError("INVALID_RUN_ID", "后台更新不能切换任务。", 422);
      document.snapshot = projectAmazonCollectionSnapshot(next, document.amazonCollection);
      document.updatedAt = new Date().toISOString();
      document.snapshot.savedAt = document.updatedAt;
      await this.writeRunFile(runId, document);
      this.upsertSummary(summaryFromDocument(document));
      this.touchIndex();
      await this.persistIndex();
      this.notifySnapshotUpdated(runId);
      return cloneJson(document.snapshot);
    });
  }

  async getRunArtifactPath(runId) {
    assertRunId(runId);
    await this.ready();
    await this.writeQueue;
    const candidatePath = this.runPath(runId);
    try {
      const [runsRoot, candidateStats] = await Promise.all([
        realpath(this.runsDirectory),
        lstat(candidatePath),
      ]);
      if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) {
        throw new PersistenceStoreError("RUN_ARTIFACT_UNAVAILABLE", "The saved run artifact is not a regular file.", 500);
      }
      const artifactPath = await realpath(candidatePath);
      const relativePath = path.relative(runsRoot, artifactPath);
      if (!relativePath
        || path.isAbsolute(relativePath)
        || relativePath.startsWith(`..${path.sep}`)
        || path.dirname(relativePath) !== ".") {
        throw new PersistenceStoreError("RUN_ARTIFACT_UNAVAILABLE", "The saved run artifact is outside the run directory.", 500);
      }
      return artifactPath;
    } catch (error) {
      if (error instanceof PersistenceStoreError) throw error;
      if (error?.code === "ENOENT") {
        throw new PersistenceStoreError("RUN_ARTIFACT_NOT_FOUND", "The saved run artifact was not found.", 404);
      }
      throw new PersistenceStoreError("RUN_ARTIFACT_UNAVAILABLE", "The saved run artifact could not be accessed.", 500);
    }
  }

  async load() {
    await mkdir(this.runsDirectory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8"));
      this.index = normalizeIndex(parsed);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        process.stderr.write("Scout history index could not be read; a new in-memory index is being used.\n");
      }
    }
  }

  enqueue(operation) {
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  upsertSummary(summary) {
    this.index.runs = [summary, ...this.index.runs.filter((item) => item.id !== summary.id)]
      .sort((left, right) => String(right.completedAt || right.startedAt || "").localeCompare(String(left.completedAt || left.startedAt || "")));
  }

  touchIndex() {
    this.index.updatedAt = new Date().toISOString();
  }

  async persistIndex() {
    await atomicWriteJson(this.indexPath, this.index);
  }

  async readRunFile(runId) {
    try {
      return JSON.parse(await readFile(this.runPath(runId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new PersistenceStoreError("RUN_READ_FAILED", "The saved run could not be read.", 500);
    }
  }

  async writeRunFile(runId, value) {
    await atomicWriteJson(this.runPath(runId), value);
  }

  runPath(runId) {
    const digest = createHash("sha256").update(runId).digest("hex");
    return path.join(this.runsDirectory, `${digest}.json`);
  }
}

function defaultDataDirectory() {
  const configured = String(process.env.SCOUT_DATA_DIR || "").trim();
  return configured ? path.resolve(configured) : path.resolve(MODULE_DIRECTORY, "..", "data");
}

function emptyIndex() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: null,
    totalSellerSpriteCalls: 0,
    amazonConnectionChecks: {},
    latestRunId: null,
    amazonCollectionRunId: null,
    supplierPipelineRunId: null,
    runToolCalls: {},
    runs: [],
  };
}

function emptyRunDocument(runId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: runId,
    marketplace: null,
    startedAt: null,
    completedAt: null,
    status: "collecting",
    updatedAt: null,
    sellerSprite: { total: 0, byTool: {} },
    searchBatches: [],
    asinDetails: {},
    competitorLookups: {},
    amazonStoreCheckpoints: {},
    amazonDiscoverySummary: null,
    amazonCollection: { job: null, items: {} },
    snapshot: null,
  };
}

function compactAmazonDiscoverySummary(batch) {
  const response = isPlainObject(batch.response) ? batch.response : {};
  const audit = isPlainObject(response.visitAudit) ? response.visitAudit : {};
  return {
    phase: "discover",
    collectedAt: typeof batch.collectedAt === "string" ? batch.collectedAt : new Date().toISOString(),
    marketplace: cleanMarketplace(batch.marketplace),
    requestedStores: Array.isArray(batch.requestedStores) ? batch.requestedStores.length : nonNegativeInteger(response.requestedStores),
    processedStores: nonNegativeInteger(response.processedStores),
    discoveredAsins: nonNegativeInteger(audit.discoveredAsins),
    visited: nonNegativeInteger(audit.visited),
    pending: nonNegativeInteger(audit.pending),
    waiting: nonNegativeInteger(audit.waiting),
    visitFailed: nonNegativeInteger(audit.visitFailed),
    discoveryComplete: response.discoveryComplete === true,
  };
}

function clientSnapshotFromDocument(document) {
  if (!document?.snapshot) return null;
  const snapshot = projectAmazonCollectionSnapshot(document.snapshot, document.amazonCollection, { includeItems: true });
  const sources = new Map();
  const addSource = (value) => {
    if (!isPlainObject(value)) return;
    const marketplace = cleanMarketplace(value.marketplace || snapshot.runState?.marketplace);
    const sellerId = cleanShortText(value.sellerId, 20)?.toUpperCase() || null;
    const storeIndex = Number.isInteger(value.storeIndex) && value.storeIndex >= 0 ? value.storeIndex : null;
    const asins = [...new Set((Array.isArray(value.asins) ? value.asins : [])
      .map((asin) => String(asin || "").trim().toUpperCase())
      .filter((asin) => /^[A-Z0-9]{10}$/.test(asin)))];
    if (!marketplace || !asins.length) return;
    const key = `${marketplace}:${sellerId || `store-${storeIndex ?? sources.size}`}`;
    const existing = sources.get(key);
    sources.set(key, {
      marketplace,
      sellerId,
      sellerName: cleanShortText(value.sellerName, 200),
      storeIndex,
      rowNumbers: Array.isArray(value.rowNumbers)
        ? value.rowNumbers.filter((row) => Number.isInteger(row) && row > 0).slice(0, 1_000)
        : [],
      asins: [...new Set([...(existing?.asins || []), ...asins])],
      collectedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    });
  };

  Object.values(isPlainObject(document.amazonStoreCheckpoints) ? document.amazonStoreCheckpoints : {}).forEach(addSource);
  (snapshot.storeList?.stores || []).forEach(addSource);
  snapshot.amazonDiscoveredSources = [...sources.values()];
  return snapshot;
}

function normalizeAmazonCollection(value, existing) {
  if (!isPlainObject(value) || (value.job !== null && !isPlainObject(value.job)) || !isPlainObject(value.items)) {
    throw new PersistenceStoreError("INVALID_AMAZON_COLLECTION", "Collection state must contain a job and an ASIN result map.");
  }
  if (value.job && (!Number.isSafeInteger(value.job.revision) || value.job.revision < 0)) {
    throw new PersistenceStoreError("INVALID_AMAZON_COLLECTION_REVISION", "Collection revision must be a non-negative integer.");
  }
  if (value.job && Number(value.job.revision) < Number(existing?.job?.revision || 0)) {
    throw new PersistenceStoreError("STALE_COLLECTION_UPDATE", "采集任务版本已更新，不能写回旧版本。", 409);
  }
  const items = { ...(existing?.items || {}), ...value.items };
  for (const [asin, item] of Object.entries(items)) {
    if (!/^[A-Z0-9]{10}$/.test(asin) || !isPlainObject(item)
      || (item.asin && item.asin !== asin) || (item.sourceAsin && item.sourceAsin !== asin)) {
      throw new PersistenceStoreError("INVALID_AMAZON_COLLECTION_ITEM", "Collection results must be keyed by their matching ASIN.");
    }
  }
  return cloneJson({ job: value.job, items });
}

function projectAmazonCollectionSnapshot(value, collection, { includeItems = false } = {}) {
  const snapshot = cloneJson(value);
  if (isPlainObject(collection)) snapshot.products = mergeAmazonCollectionProducts(snapshot.products, collection.items || {}, snapshot.runState);
  snapshot.products = snapshot.products.map((product) => compactProductForPersistence(recomputeProductProfit(product, snapshot)));
  if (isPlainObject(collection?.job)) {
    const job = cloneJson(collection.job);
    if (includeItems) snapshot.amazonCollection = { ...job, items: Object.values(cloneJson(collection.items || {})) };
    else delete snapshot.amazonCollection;
    snapshot.runState.amazonCollectionRevision = nonNegativeInteger(job.revision);
    snapshot.runState.amazonCollectionJob = job;
    if (["queued", "running", "cooldown", "completed"].includes(job.status)) snapshot.runState.mode = "live";
    if (["paused", "needs_attention"].includes(job.status)) snapshot.runState.mode = "error";
    snapshot.runState.completedAt = job.completedAt || null;
  }
  return snapshot;
}

// 快照持久化前对单个商品做体积裁剪。1688 找厂的 supplierSearchAudit 会携带
// rejected（完整报价对象数组，含相似度分数、报价、链接等冗余字段），单商品可达
// ~100KB，1176 个商品会令快照膨胀到 200MB+，并在每次 checkpoint 全量序列化时
// 触发 OOM。此处仅保留运行/展示所需的标量摘要，把 rejected/accepted 明细压成
// excludedReason 计数，避免破坏利润计算与前端展示。
function compactProductForPersistence(product) {
  if (!isPlainObject(product)) return product;
  const audit = product.supplierSearchAudit;
  if (!isPlainObject(audit)) return product;
  const compacted = {};
  // 标量字段原样保留（这些是利润/展示/断点恢复所需的摘要，体积可忽略）。
  for (const key of [
    "target", "rawCandidateCount", "similarity", "groups", "selectionMode",
    "costConfidence", "procurementTaskId", "procurementTaskStatus", "procurementTaskReused",
    "imageCandidatesReturned", "imageCandidatesCompared", "imageQualifiedUniqueCount",
    "mergedQualifiedUniqueCount", "finalFallbackEligibleUniqueCount", "finalMergedCandidateCount",
    "searchAttempts", "searchStrategyVersion", "sharedContext", "onlineAuthRequired",
  ]) {
    if (key in audit) compacted[key] = audit[key];
  }
  // rejected: 完整报价明细 → excludedReason 计数摘要（保留排障语义，砍掉体积）。
  // 幂等保护：已裁剪过的摘要（summary:true）直接透传，避免 clientSnapshotFromDocument
  // 二次 project 时把摘要对象当成空数组重置。
  if (isPlainObject(audit.rejected) && audit.rejected.summary === true) {
    compacted.rejected = audit.rejected;
  } else {
    const rejected = Array.isArray(audit.rejected) ? audit.rejected : [];
    const rejectedReasons = {};
    for (const quote of rejected) {
      if (!isPlainObject(quote)) continue;
      const reason = String(quote.excludedReason || "unspecified").slice(0, 80) || "unspecified";
      rejectedReasons[reason] = (rejectedReasons[reason] || 0) + 1;
    }
    compacted.rejected = { summary: true, count: rejected.length, reasons: rejectedReasons };
  }
  // accepted: 仅保留精简的 (supplierId, unitPriceCny, rank) 三元组，去掉相似度明细。
  const accepted = Array.isArray(audit.accepted) ? audit.accepted : [];
  compacted.accepted = accepted.slice(0, 200).map((quote) => isPlainObject(quote)
    ? {
        supplierId: quote.supplierId ?? null,
        offerId: quote.offerId ?? null,
        rank: Number.isFinite(Number(quote.rank)) ? Number(quote.rank) : null,
        unitPriceCny: Number.isFinite(Number(quote.unitPriceCny)) ? Number(quote.unitPriceCny) : null,
      }
    : null).filter(Boolean);
  return { ...product, supplierSearchAudit: compacted };
}

function assertCurrentAmazonCollectionSnapshot(collection, snapshot) {
  if (!isPlainObject(collection?.job)) return;
  const currentRevision = nonNegativeInteger(collection.job.revision);
  const submittedRevision = nonNegativeInteger(snapshot.runState?.amazonCollectionRevision);
  if (submittedRevision < currentRevision) {
    throw new PersistenceStoreError(
      "STALE_COLLECTION_SNAPSHOT",
      "后台采集结果已更新，请刷新或合并最新任务数据后再保存。",
      409,
    );
  }
}

function assertCurrentAmazonPriceSnapshot(existingSnapshot, submittedSnapshot) {
  if (!Array.isArray(existingSnapshot?.products)) return;
  const savedProducts = new Map(existingSnapshot.products.map((product) => [product.id, product]));
  const hasManualPrice = (product) => product?.manualAmazonFields?.currentPrice === true
    || product?.manualAmazonOverride === true || product?.fieldSources?.currentPrice === "manual";
  const draftVersion = (product) => Number.isSafeInteger(product?.analysisDraft?.version)
    && product.analysisDraft.version >= 2 ? product.analysisDraft.version : 1;
  for (const submitted of submittedSnapshot.products) {
    const existing = savedProducts.get(submitted.id);
    if (!existing || hasManualPrice(existing) || hasManualPrice(submitted)
      || draftVersion(existing) !== draftVersion(submitted)) continue;
    const amazonPrice = (existing.analysisSourceMode || existingSnapshot.runState?.analysisSourceMode) === "amazon_only"
      || existing.fieldSources?.currentPrice === "amazon_product_page";
    if (!amazonPrice) continue;
    const savedParserVersion = nonNegativeInteger(existing.detailParserVersion);
    const requiredVersion = Math.max(savedParserVersion, nonNegativeInteger(existing.priceRevalidation?.requiredParserVersion));
    if (requiredVersion < 5 || nonNegativeInteger(submitted.detailParserVersion) >= requiredVersion) continue;
    // An unfinished migration must remain saveable between detail batches.
    // Once extraction succeeds, older migrated tabs must also reload first.
    const pendingMigration = savedParserVersion < requiredVersion
      && nonNegativeInteger(submitted.priceRevalidation?.requiredParserVersion) >= requiredVersion
      && submitted.currentPrice === null;
    if (pendingMigration) continue;
    throw new PersistenceStoreError(
      "STALE_PRICE_SNAPSHOT",
      "商品售价已重新核验或正在核验，当前页面的数据已过期，请刷新页面后再保存。",
      409,
    );
  }
}

function mergeSnapshotProducts(existingSnapshot, submittedSnapshot) {
  if (!isPlainObject(existingSnapshot) || !Array.isArray(existingSnapshot.products)) return submittedSnapshot;
  const products = new Map();
  existingSnapshot.products.forEach((product) => {
    if (isPlainObject(product) && typeof product.id === "string") products.set(product.id, product);
  });
  submittedSnapshot.products.forEach((product) => {
    products.set(product.id, mergeAnalysisDraftProduct(products.get(product.id), product));
  });
  const mergedProducts = [...products.values()];
  const existingCoverage = isPlainObject(existingSnapshot.runState?.coverage) ? existingSnapshot.runState.coverage : {};
  const submittedCoverage = isPlainObject(submittedSnapshot.runState?.coverage) ? submittedSnapshot.runState.coverage : {};
  const discoveredAsins = Math.max(
    nonNegativeInteger(existingCoverage.discoveredAsins),
    nonNegativeInteger(submittedCoverage.discoveredAsins),
    mergedProducts.length,
  );
  return validateSnapshot({
    ...submittedSnapshot,
    products: mergedProducts,
    runState: {
      ...submittedSnapshot.runState,
      coverage: {
        ...submittedCoverage,
        discoveredAsins,
        products: mergedProducts.length,
      },
    },
  });
}

function mergeAnalysisDraftProduct(existing, submitted) {
  const draftVersion = (product) => {
    const version = product?.analysisDraft?.version;
    return Number.isSafeInteger(version) && version >= 2 ? version : null;
  };
  const existingVersion = draftVersion(existing);
  const submittedVersion = draftVersion(submitted);
  // Products predating local analysis versions keep their original replacement semantics.
  if (existingVersion === null && submittedVersion === null) return submitted;
  if (existingVersion !== null && existingVersion > (submittedVersion ?? 1)) return existing;

  const existingHistory = Array.isArray(existing?.analysisHistory) ? existing.analysisHistory : [];
  const submittedHistory = Array.isArray(submitted.analysisHistory) ? submitted.analysisHistory : [];
  if (!existingHistory.length && !Array.isArray(submitted.analysisHistory)) return submitted;
  const history = new Map();
  // Saved archives win collisions: an editable draft cannot rewrite an earlier handed-off snapshot.
  [...existingHistory, ...submittedHistory].forEach((archive) => {
    const key = JSON.stringify([archive?.version, archive?.product?.analysisHandoff?.revision]);
    if (!history.has(key)) history.set(key, archive);
  });
  return { ...submitted, analysisHistory: [...history.values()] };
}

function asinDetailKey(marketplace, asin) {
  const normalizedMarketplace = String(marketplace || "").trim().toUpperCase();
  const normalizedAsin = String(asin || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalizedMarketplace) || !/^[A-Z0-9]{10}$/.test(normalizedAsin)) {
    throw new PersistenceStoreError("INVALID_ASIN_DETAIL_KEY", "The ASIN detail checkpoint key is invalid.");
  }
  return `${normalizedMarketplace}:${normalizedAsin}`;
}

function competitorLookupKey(marketplace, month, asin) {
  return `${marketplace}:${month}:${asin}`;
}

function amazonStoreCheckpointKey(marketplace, sellerId) {
  return `${marketplace}:${sellerId}`;
}

// 店铺卡片月销量角标读数（asin -> { sales30, rawText }），随断点保存/恢复。
function normalizeAmazonStoreCheckpointSales(value) {
  const sales = {};
  const source = isPlainObject(value) ? value : {};
  for (const [rawAsin, entry] of Object.entries(source)) {
    const asin = String(rawAsin || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
    const sales30 = Number.isInteger(entry?.sales30) && entry.sales30 >= 0 ? entry.sales30 : null;
    if (sales30 === null) continue;
    const rawText = String(entry?.rawText || "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
    sales[asin] = rawText ? { sales30, rawText } : { sales30 };
    if (Object.keys(sales).length >= MAX_AMAZON_STORE_ASINS) break;
  }
  return sales;
}

function normalizeAmazonStoreCheckpoint(value) {
  if (!isPlainObject(value)) {
    throw new PersistenceStoreError("INVALID_AMAZON_STORE_CHECKPOINT", "The Amazon store checkpoint must be an object.");
  }
  const marketplace = cleanMarketplace(value.marketplace);
  const sellerId = String(value.sellerId || "").trim().toUpperCase();
  if (!marketplace || !/^[A-Z0-9]{8,20}$/.test(sellerId)) {
    throw new PersistenceStoreError(
      "INVALID_AMAZON_STORE_CHECKPOINT_KEY",
      "The Amazon store checkpoint marketplace or seller ID is invalid.",
    );
  }
  if (!Array.isArray(value.asins) || value.asins.length > MAX_AMAZON_STORE_ASINS) {
    throw new PersistenceStoreError(
      "INVALID_AMAZON_STORE_CHECKPOINT_ASINS",
      `Amazon store checkpoint ASINs must contain at most ${MAX_AMAZON_STORE_ASINS} entries.`,
    );
  }
  const asins = [...new Set(value.asins.map((asin) => {
    const normalized = String(asin || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(normalized)) {
      throw new PersistenceStoreError(
        "INVALID_AMAZON_STORE_CHECKPOINT_ASIN",
        "Every Amazon store checkpoint ASIN must contain exactly 10 letters or digits.",
      );
    }
    return normalized;
  }))];
  const status = ["pending", "running", "waiting", "complete", "failed"].includes(value.status)
    ? value.status
    : "pending";
  const complete = value.complete === true;
  const nextHref = normalizeAmazonCheckpointUrl(value.nextHref, marketplace);
  if (complete && nextHref) {
    throw new PersistenceStoreError(
      "INVALID_AMAZON_STORE_CHECKPOINT_STATE",
      "A complete Amazon store checkpoint cannot retain a next-page URL.",
    );
  }
  const updatedAt = typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
    ? new Date(value.updatedAt).toISOString()
    : new Date().toISOString();
  const interruption = isPlainObject(value.interruption)
    ? {
        code: cleanShortText(value.interruption.code, 80) || "AMAZON_STORE_VISIT_INTERRUPTED",
        message: cleanShortText(value.interruption.message, 500) || "Amazon store discovery was interrupted.",
      }
    : null;
  return {
    marketplace,
    sellerId,
    sellerName: cleanShortText(value.sellerName, 200),
    storeIndex: Number.isInteger(value.storeIndex) && value.storeIndex >= 0 ? value.storeIndex : null,
    rowNumbers: Array.isArray(value.rowNumbers)
      ? value.rowNumbers.filter((row) => Number.isInteger(row) && row > 0).slice(0, 1_000)
      : [],
    asins,
    salesByAsin: normalizeAmazonStoreCheckpointSales(value.salesByAsin),
    excludedUnder50Count: nonNegativeInteger(value.excludedUnder50Count),
    pagesVisited: nonNegativeInteger(value.pagesVisited),
    reportedTotalAsins: Number.isInteger(value.reportedTotalAsins) && value.reportedTotalAsins >= 0
      ? value.reportedTotalAsins
      : null,
    notEnumeratedAsins: nonNegativeInteger(value.notEnumeratedAsins),
    ...normalizeAmazonStoreCoverage(value, { marketplace, sellerId }),
    truncated: value.truncated === true,
    complete,
    nextHref,
    canonicalUrl: normalizeAmazonCheckpointUrl(value.canonicalUrl, marketplace),
    interruption,
    status: complete ? "complete" : status,
    deliveryPostalCode: cleanShortText(value.deliveryPostalCode, 20),
    deliveryRegionReady: value.deliveryRegionReady === true,
    deliveryRegionMode: ["postal_code", "marketplace_domain"].includes(value.deliveryRegionMode)
      ? value.deliveryRegionMode
      : null,
    attempt: nonNegativeInteger(value.attempt),
    retryAt: typeof value.retryAt === "string" && Number.isFinite(Date.parse(value.retryAt))
      ? new Date(value.retryAt).toISOString()
      : null,
    updatedAt,
  };
}

export function normalizeAmazonStoreCoverage(value = {}, { marketplace = value?.marketplace, sellerId = value?.sellerId } = {}) {
  const source = isPlainObject(value) ? value : {};
  const nullableCount = (candidate) => Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
  const observedDate = (candidate) => typeof candidate === "string" && Number.isFinite(Date.parse(candidate))
    ? new Date(candidate).toISOString() : null;
  const safePageUrl = (candidate) => {
    const normalized = normalizeAmazonCheckpointUrl(candidate, marketplace);
    if (!normalized) return null;
    const parsed = new URL(normalized);
    const expectedSeller = String(sellerId || "").trim().toUpperCase();
    const marketplaceId = {
      AU: "A39IBJ37TRP1C6",
      US: "ATVPDKIKX0DER",
      NL: "A1805IZSGTT6HS",
      CA: "A2EUQ1WTGCTBG2",
      UK: "A1F83G8C2ARO7P",
      DE: "A1PA6795UKMFR9",
      FR: "A13V1IB3VIYZZH",
      IT: "APJ6JRA9NG5V4",
      ES: "A1RKKUPIHCS9HS",
      PL: "A1C3SOZRARQ6R3",
      MX: "A1AM78C64UM0Y8",
      BR: "A2Q3Y263D00KWC",
    }[marketplace];
    if (!/^\/(?:s|-\/[a-z]{2}(?:-[a-z]{2})?\/s)$/i.test(parsed.pathname)
      || !expectedSeller || parsed.searchParams.get("me")?.toUpperCase() !== expectedSeller
      || (parsed.searchParams.has("marketplaceID") && parsed.searchParams.get("marketplaceID") !== marketplaceId)) {
      throw new PersistenceStoreError("INVALID_AMAZON_STORE_CHECKPOINT_URL", "The page audit must remain on the selected seller's search results.");
    }
    return normalized;
  };
  const pageAudit = (Array.isArray(source.pageAudit) ? source.pageAudit : []).map((entry) => {
    if (!isPlainObject(entry) || !entry.url) {
      throw new PersistenceStoreError("INVALID_AMAZON_STORE_PAGE_AUDIT", "Every page audit entry must include its visited URL.");
    }
    return {
      url: safePageUrl(entry.url), nextHref: safePageUrl(entry.nextHref),
      collectedAt: observedDate(entry.collectedAt),
      status: ["success", "failed"].includes(entry.status) ? entry.status : "pending",
      code: cleanShortText(entry.code, 80),
      exhausted: typeof entry.exhausted === "boolean" ? entry.exhausted : null,
      resultAsinCount: nullableCount(entry.resultAsinCount), addedAsinCount: nullableCount(entry.addedAsinCount),
      observedAsins: [...new Set((Array.isArray(entry.observedAsins) ? entry.observedAsins : []).filter(asin => /^[A-Z0-9]{10}$/i.test(asin || "")).map(asin => asin.toUpperCase()))],
      badgeExcludedCount: nullableCount(entry.badgeExcludedCount), badgeGateActive: entry.badgeGateActive === true,
      duplicateAsinCount: nullableCount(entry.duplicateAsinCount), deferredAsinCount: nullableCount(entry.deferredAsinCount),
      reportedTotalAsins: nullableCount(entry.reportedTotalAsins),
      reportedTotalKind: ["exact", "lower_bound", "unknown", "legacy_unverified"].includes(entry.reportedTotalKind) ? entry.reportedTotalKind : "unknown",
      variantLinks: (Array.isArray(entry.variantLinks) ? entry.variantLinks : [])
        .filter((link) => isPlainObject(link) && /^[A-Z0-9]{10}$/i.test(link.cardAsin || "") && /^[A-Z0-9]{10}$/i.test(link.linkedAsin || ""))
        .map((link) => ({ cardAsin: link.cardAsin.toUpperCase(), linkedAsin: link.linkedAsin.toUpperCase(), relationship: "linked_product_unverified_variant" })),
    };
  });
  const supplied = isPlainObject(source.coverageEvidence) ? source.coverageEvidence : {};
  const successful = pageAudit.filter((page) => page.status === "success");
  const total = nullableCount(source.reportedTotalAsins);
  const matchingKinds = successful.filter((page) => page.reportedTotalAsins === total).map((page) => page.reportedTotalKind);
  const reportedTotalKind = matchingKinds.includes("lower_bound") ? "lower_bound" : matchingKinds.includes("exact") ? "exact"
    : ["exact", "lower_bound", "unknown", "legacy_unverified"].includes(supplied.reportedTotalKind) ? supplied.reportedTotalKind
      : total === null ? "unknown" : "legacy_unverified";
  const hasActualPagination = supplied.paginationComplete === true || source.complete === true;
  const paginationComplete = hasActualPagination && !source.nextHref && !source.interruption;
  const knownMissingAsins = total === null ? null : nullableCount(source.notEnumeratedAsins)
    ?? Math.max(0, total - new Set([...(Array.isArray(source.asins) ? source.asins : []), ...successful.flatMap(page => page.observedAsins)]).size);
  return {
    pageAudit,
    coverageEvidence: {
      version: "1.0", scope: "amazon_visible_store_results", fullStoreComplete: false, paginationComplete,
      status: paginationComplete && !source.truncated && knownMissingAsins === 0 && reportedTotalKind === "exact" ? "visible_scope_complete" : "partial",
      reportedTotalKind, knownMissingAsins,
      collectedAt: pageAudit.at(-1)?.collectedAt || observedDate(supplied.collectedAt),
      successfulPageAttempts: successful.length,
      failedPageAttempts: pageAudit.filter((page) => page.status === "failed").length,
      duplicateAsinOccurrences: successful.reduce((sum, page) => sum + (page.duplicateAsinCount || 0), 0),
      variantScope: "search_result_cards; linked_asins_audit_only; unseen_child_variants_not_expanded",
    },
  };
}

function normalizeAmazonCheckpointUrl(value, marketplace) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 4_096) {
    throw new PersistenceStoreError("INVALID_AMAZON_STORE_CHECKPOINT_URL", "The Amazon checkpoint URL is invalid.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PersistenceStoreError("INVALID_AMAZON_STORE_CHECKPOINT_URL", "The Amazon checkpoint URL is invalid.");
  }
  const hostByMarketplace = {
    AU: "www.amazon.com.au",
    US: "www.amazon.com",
    NL: "www.amazon.nl",
    CA: "www.amazon.ca",
    UK: "www.amazon.co.uk",
    DE: "www.amazon.de",
    FR: "www.amazon.fr",
    IT: "www.amazon.it",
    ES: "www.amazon.es",
    PL: "www.amazon.pl",
    MX: "www.amazon.com.mx",
    BR: "www.amazon.com.br",
  };
  if (
    url.protocol !== "https:"
    || url.hostname !== hostByMarketplace[marketplace]
    || url.port
    || url.username
    || url.password
    || url.hash
  ) {
    throw new PersistenceStoreError(
      "INVALID_AMAZON_STORE_CHECKPOINT_URL",
      "The Amazon checkpoint URL must remain on the selected Amazon marketplace.",
    );
  }
  return url.toString();
}

function normalizeCompetitorMarketplace(value) {
  const marketplace = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(marketplace)) {
    throw new PersistenceStoreError(
      "INVALID_COMPETITOR_LOOKUP_MARKETPLACE",
      "marketplace must be a two-letter code.",
    );
  }
  return marketplace;
}

function normalizeCompetitorMonth(value) {
  const month = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^(?:nearly|\d{6})$/.test(month)) {
    throw new PersistenceStoreError(
      "INVALID_COMPETITOR_LOOKUP_MONTH",
      "month must be nearly or a six-digit month value.",
    );
  }
  return month;
}

function normalizeCompetitorAsin(value) {
  const asin = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new PersistenceStoreError(
      "INVALID_COMPETITOR_LOOKUP_ASIN",
      "Every competitor lookup ASIN must contain exactly 10 letters or digits.",
    );
  }
  return asin;
}

function normalizeCollectedAt(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new PersistenceStoreError(
      "INVALID_COMPETITOR_LOOKUP_COLLECTED_AT",
      "collectedAt must be a valid date-time string.",
    );
  }
  return new Date(value).toISOString();
}

function normalizeIndex(value) {
  if (!isPlainObject(value) || value.schemaVersion !== SCHEMA_VERSION) return emptyIndex();
  const index = emptyIndex();
  index.updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : null;
  index.totalSellerSpriteCalls = nonNegativeInteger(value.totalSellerSpriteCalls);
  index.amazonConnectionChecks = normalizeAmazonConnectionChecks(value.amazonConnectionChecks);
  index.latestRunId = typeof value.latestRunId === "string" && RUN_ID_PATTERN.test(value.latestRunId) ? value.latestRunId : null;
  index.amazonCollectionRunId = typeof value.amazonCollectionRunId === "string" && RUN_ID_PATTERN.test(value.amazonCollectionRunId)
    ? value.amazonCollectionRunId : null;
  index.supplierPipelineRunId = typeof value.supplierPipelineRunId === "string" && RUN_ID_PATTERN.test(value.supplierPipelineRunId)
    ? value.supplierPipelineRunId : null;
  index.runToolCalls = normalizeRunToolCalls(value.runToolCalls);
  index.runs = Array.isArray(value.runs)
    ? value.runs.filter(isPlainObject).map(normalizeSummary).filter(Boolean)
    : [];
  return index;
}

function normalizeAmazonConnectionChecks(value) {
  if (!isPlainObject(value)) return {};
  const checks = {};
  for (const marketplace of ["AU", "US", "NL", "CA", "UK", "DE", "FR", "IT", "ES", "PL", "MX", "BR"]) {
    const check = normalizeAmazonConnectionCheck(value[marketplace], marketplace);
    if (check) checks[marketplace] = check;
  }
  return checks;
}

function normalizeAmazonConnectionCheck(value, requiredMarketplace = null) {
  if (!isPlainObject(value)) return null;
  const marketplace = cleanMarketplace(value.marketplace);
  const sellerId = String(value.sellerId || "").trim().toUpperCase();
  const checkedAt = typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt))
    ? new Date(value.checkedAt).toISOString()
    : null;
  const ready = value.ready === true;
  const status = ready ? "live" : value.ready === false ? "error" : null;
  const deliveryRegionMode = ["postal_code", "marketplace_domain"].includes(value.deliveryRegionMode)
    ? value.deliveryRegionMode
    : null;
  const deliveryPostalCode = cleanShortText(value.deliveryPostalCode, 20);
  const deliveryRegionReady = value.deliveryRegionReady === true;
  if (!marketplace
    || (requiredMarketplace && marketplace !== requiredMarketplace)
    || !/^[A-Z0-9]{8,20}$/.test(sellerId)
    || !checkedAt
    || value.status !== status
    || (ready && (!deliveryRegionReady || !deliveryRegionMode))
    || (deliveryRegionMode === "postal_code" && !deliveryPostalCode)) {
    return null;
  }
  return {
    marketplace,
    sellerId,
    status,
    ready,
    checkedAt,
    durationMs: nonNegativeInteger(value.durationMs),
    pagesVisited: nonNegativeInteger(value.pagesVisited),
    discoveredAsins: nonNegativeInteger(value.discoveredAsins),
    empty: value.empty === true,
    hasMore: value.hasMore === true,
    deliveryPostalCode,
    deliveryRegionReady,
    deliveryRegionMode,
    code: ready ? null : cleanShortText(value.code, 80) || "AMAZON_CONNECTION_CHECK_FAILED",
    message: ready ? null : cleanShortText(value.message, 500) || "Amazon connection check failed.",
    retryable: ready ? false : value.retryable === true,
  };
}

function normalizeRunToolCalls(value) {
  if (!isPlainObject(value)) return {};
  const normalized = {};
  for (const [runId, entry] of Object.entries(value)) {
    if (!RUN_ID_PATTERN.test(runId) || !isPlainObject(entry)) continue;
    const byTool = {};
    if (isPlainObject(entry.byTool)) {
      for (const [tool, count] of Object.entries(entry.byTool)) {
        const toolName = cleanShortText(tool, 80);
        if (toolName) byTool[toolName] = nonNegativeInteger(count);
      }
    }
    normalized[runId] = { total: nonNegativeInteger(entry.total), byTool };
  }
  return normalized;
}

function normalizeSummary(value) {
  if (typeof value.id !== "string" || !RUN_ID_PATTERN.test(value.id)) return null;
  return {
    id: value.id,
    marketplace: cleanMarketplace(value.marketplace),
    status: cleanShortText(value.status, 32) || "unknown",
    mode: cleanShortText(value.mode, 32) || "idle",
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    productCount: nonNegativeInteger(value.productCount),
    completeCount: nonNegativeInteger(value.completeCount),
    approvedCount: nonNegativeInteger(value.approvedCount),
    storeCount: nonNegativeInteger(value.storeCount),
    sellerSpriteCalls: nonNegativeInteger(value.sellerSpriteCalls),
    sellerSpriteCallsByTool: isPlainObject(value.sellerSpriteCallsByTool) ? { ...value.sellerSpriteCallsByTool } : {},
    dataSource: cleanShortText(value.dataSource, 240),
    hasSnapshot: value.hasSnapshot === true,
  };
}

function validateSnapshot(value) {
  if (!isPlainObject(value)) throw new PersistenceStoreError("INVALID_RUN_SNAPSHOT", "The run snapshot must be an object.");
  if (!isPlainObject(value.runState)) throw new PersistenceStoreError("INVALID_RUN_STATE", "runState must be an object.");
  assertRunId(value.runState.id);
  if (!Array.isArray(value.products)) {
    throw new PersistenceStoreError("INVALID_RUN_PRODUCTS", "products must be an array.");
  }
  if (value.products.some((product) => !isPlainObject(product))) {
    throw new PersistenceStoreError("INVALID_RUN_PRODUCTS", "Every saved product must be an object.");
  }
  for (const product of value.products) {
    if (typeof product.id !== "string" || !PRODUCT_ID_PATTERN.test(product.id)) {
      throw new PersistenceStoreError("INVALID_RUN_PRODUCTS", "Every saved product must have a safe, stable id.");
    }
    for (const field of ["visualIcon", "visualTone"]) {
      if (product[field] !== null && product[field] !== undefined
        && (typeof product[field] !== "string" || !CSS_TOKEN_PATTERN.test(product[field]))) {
        throw new PersistenceStoreError("INVALID_RUN_PRODUCTS", `${field} contains an invalid UI token.`);
      }
    }
  }
  for (const field of ["criteria", "resultCriteria", "storeList", "costParams", "profitModel"]) {
    if (value[field] !== null && value[field] !== undefined && !isPlainObject(value[field])) {
      throw new PersistenceStoreError("INVALID_RUN_SNAPSHOT", `${field} must be an object or null.`);
    }
  }
  const marketplace = cleanMarketplace(value.runState.marketplace);
  if (!marketplace) throw new PersistenceStoreError("INVALID_RUN_MARKETPLACE", "The saved run marketplace is invalid.");
  return cloneJson({
    schemaVersion: SCHEMA_VERSION,
    runState: value.runState,
    products: value.products,
    criteria: value.criteria || {},
    resultCriteria: value.resultCriteria || {},
    storeList: value.storeList || null,
    costParams: value.costParams || null,
    profitModel: value.profitModel || null,
    resultsCompleteOnly: value.resultsCompleteOnly !== false,
    savedAt: new Date().toISOString(),
  });
}

function summaryFromDocument(document) {
  const snapshot = document.snapshot;
  const products = Array.isArray(snapshot?.products) ? snapshot.products : [];
  const storeList = snapshot?.storeList;
  const batchProductCount = (document.searchBatches || []).reduce((maximum, batch) => Math.max(maximum, Number(batch?.productCount || 0)), 0);
  return {
    id: document.id,
    marketplace: cleanMarketplace(snapshot?.runState?.marketplace || document.marketplace),
    status: document.status || "collecting",
    mode: cleanShortText(snapshot?.runState?.mode, 32) || (document.status === "failed" ? "error" : "live"),
    startedAt: snapshot?.runState?.startedAt || document.startedAt || null,
    completedAt: snapshot?.runState?.completedAt || document.completedAt || null,
    updatedAt: document.updatedAt || null,
    productCount: products.length || batchProductCount,
    completeCount: products.filter((product) => product.complete === true).length,
    approvedCount: products.filter((product) => product.reviewStatus === "approved").length,
    storeCount: nonNegativeInteger(storeList?.audit?.uniqueSellers ?? storeList?.stores?.length),
    sellerSpriteCalls: nonNegativeInteger(document.sellerSprite?.total),
    sellerSpriteCallsByTool: isPlainObject(document.sellerSprite?.byTool) ? { ...document.sellerSprite.byTool } : {},
    dataSource: cleanShortText(snapshot?.runState?.dataSource, 240),
    hasSnapshot: Boolean(snapshot),
  };
}

function snapshotStatus(runState) {
  if (runState.mode === "error") return "failed";
  return runState.completedAt ? "completed" : "running";
}

function assertRunId(value) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new PersistenceStoreError("INVALID_RUN_ID", "The run ID is invalid.");
  }
}

function cleanMarketplace(value) {
  const marketplace = String(value || "").trim().toUpperCase();
  return new Set(["AU", "US", "NL", "CA", "UK", "DE", "FR", "IT", "ES", "PL", "MX", "BR"]).has(marketplace) ? marketplace : null;
}

function cleanShortText(value, maximumLength) {
  const text = typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "") : "";
  return text && text.length <= maximumLength ? text : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function atomicWriteJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, targetPath);
}

export const persistenceStore = new PersistenceStore();
await persistenceStore.ready();
