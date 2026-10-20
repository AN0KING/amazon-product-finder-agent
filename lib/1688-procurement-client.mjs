import { readFile } from "node:fs/promises";

import {
  buildSupplierSearchResult,
} from "./1688-supplier-policy.mjs";
import {
  downloadAllowedProductImage,
  downloadAllowedSupplierImage,
} from "./1688-image-download.mjs";
import { createProductImageReference, MIN_IMAGE_SIMILARITY_SCORE } from "./image-similarity.mjs";

export const PROCUREMENT_1688_ORIGIN = "http://127.0.0.1:16880";
export const PROCUREMENT_1688_PRODUCT = "1688-procurement-assistant";
export const PROCUREMENT_1688_VERSION = "2.3.0";
export const PROCUREMENT_1688_BROKER_PROTOCOL = 5;
export const PROCUREMENT_1688_INTEGRATION_PROTOCOL = 8;
export const PROCUREMENT_1688_IMAGE_CANDIDATE_LIMIT = 40;

const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_SEARCH_TIMEOUT_MS = 9 * 60_000;
const HEALTH_CACHE_MS = 30_000;
const HEALTH_PROBE_ATTEMPTS = 2;
const HEALTH_PROBE_RETRY_DELAY_MS = 250;
const SAFE_REQUEST_ATTEMPTS = 3;
const SAFE_REQUEST_RETRY_DELAYS_MS = Object.freeze([200, 600]);
const MAX_SIMILARITY_CANDIDATES = 40;
const IMAGE_COMPARISON_CONCURRENCY = 4;
export const SUPPLIER_SEARCH_STRATEGY_VERSION = "1688-image-only-always-top6-trimmed-10-v6";

export class Procurement1688Error extends Error {
  constructor(code, message, status = 502, cause = null, details = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "Procurement1688Error";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class Procurement1688Client {
  constructor({
    fetchImpl = globalThis.fetch,
    imageDownloader = downloadAllowedProductImage,
    candidateImageDownloader = downloadAllowedSupplierImage,
    imageReferenceFactory = createProductImageReference,
    readFileImpl = readFile,
    waitImpl = abortableDelay,
    now = Date.now,
    timestamp = () => new Date().toISOString(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    searchTimeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
    healthProbeAttempts = HEALTH_PROBE_ATTEMPTS,
    healthProbeRetryDelayMs = HEALTH_PROBE_RETRY_DELAY_MS,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
    this.fetchImpl = fetchImpl;
    this.imageDownloader = imageDownloader;
    this.candidateImageDownloader = candidateImageDownloader;
    this.imageReferenceFactory = imageReferenceFactory;
    this.readFileImpl = readFileImpl;
    this.waitImpl = waitImpl;
    this.now = now;
    this.timestamp = timestamp;
    this.pollIntervalMs = Math.max(50, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
    this.searchTimeoutMs = Math.max(1_000, Number(searchTimeoutMs) || DEFAULT_SEARCH_TIMEOUT_MS);
    this.healthProbeAttempts = Math.max(1, Math.min(3, Math.trunc(Number(healthProbeAttempts) || HEALTH_PROBE_ATTEMPTS)));
    this.healthProbeRetryDelayMs = Math.max(0, Number(healthProbeRetryDelayMs) || 0);
    this.healthCheckedAt = 0;
  }

  async getRuntime({ verify = false, signal } = {}) {
    await this.#assertExpectedService(signal);
    const suffix = verify ? "?verify=1" : "";
    const runtime = await this.#request(`/api/v1/runtime${suffix}`, { signal, timeoutMs: 25_000 });
    const activeTaskCount = ["queued", "running", "riskBlocked"]
      .reduce((total, key) => total + Math.max(0, Number(runtime?.queue?.[key] || 0)), 0);
    if (Array.isArray(runtime?.queue?.activeTasks)) {
      return {
        ...runtime,
        queue: {
          ...runtime.queue,
          activeTasks: runtime.queue.activeTasks
            .filter((task) => ["queued", "running", "risk_blocked"].includes(task?.status))
            .sort(compareProcurementQueueOrder)
            .map(summarizeActiveTask),
        },
      };
    }
    if (activeTaskCount < 1) {
      return {
        ...runtime,
        queue: {
          ...runtime?.queue,
          activeTasks: [],
        },
      };
    }

    const tasksPayload = await this.#request("/api/v1/tasks", { signal, timeoutMs: 20_000 });
    const activeTasks = (Array.isArray(tasksPayload?.tasks) ? tasksPayload.tasks : [])
      .filter((task) => ["queued", "running", "risk_blocked"].includes(task?.status))
      .sort(compareProcurementQueueOrder)
      .map(summarizeActiveTask);
    return {
      ...runtime,
      queue: {
        ...runtime.queue,
        activeTasks,
      },
    };
  }

  async openLogin({ restart = false, purpose = "login", taskId = null, signal } = {}) {
    const normalizedPurpose = loginPurpose(purpose);
    const normalizedTaskId = normalizedPurpose === "image_search"
      ? requireTaskId(taskId)
      : null;
    if (normalizedPurpose === "login" && taskId !== null && taskId !== undefined && taskId !== "") {
      throw new Procurement1688Error("LOGIN_TASK_NOT_ALLOWED", "普通 1688 登录不能携带图片搜索任务。", 422);
    }
    await this.#assertExpectedService(signal);
    return this.#request("/api/v1/auth/open-login", {
      method: "POST",
      body: {
        restart: restart === true,
        purpose: normalizedPurpose,
        ...(normalizedTaskId ? { taskId: normalizedTaskId } : {}),
      },
      signal,
      timeoutMs: 50_000,
    });
  }

  async resumeQueue({ signal } = {}) {
    await this.#assertExpectedService(signal);
    return this.#request("/api/v1/queue/resume", {
      method: "POST", body: { confirmed: true }, signal, timeoutMs: 15_000,
    });
  }

  async searchByImage({
    imageUrl,
    existingTaskId = null,
    targetMoq,
    targetUnit = "件",
    sellingPrice,
    sellingPriceCurrency,
    destination = "Amazon 商品成本估算",
    onTask,
    signal,
  }) {
    sellingPrice = optionalPositiveNumber(sellingPrice, "sellingPrice");
    const reusableTaskId = existingTaskId ? requireTaskId(existingTaskId) : null;
    let taskId = reusableTaskId;
    let downloaded = null;
    try {
      const runtime = await this.getRuntime({ verify: false, signal });
      let task = null;
      if (taskId) {
        // Persist the link before any work. A failed checkpoint must never
        // create a replacement task or confirm work that the caller cannot track.
        if (onTask) await onTask(taskId);
        task = await this.#getTask(taskId, signal);
      }
      const reusedCandidates = task?.status === "review_candidates";
      if (!reusedCandidates) {
        requireSearchAllowed(runtime, taskId, { now: this.now(), enqueue: !["queued", "running"].includes(task?.status) });
        if (task?.status === "risk_blocked") throw taskFailure(task);
      }
      // Completed candidates only need image comparison. They do not need a
      // new login, queue resume, task creation, or confirmation during a pause.
      downloaded = await this.imageDownloader(imageUrl, { signal });
      const image = await this.readFileImpl(downloaded.path);
      try {
        if (!taskId) {
          const created = await this.#request("/api/v1/tasks", {
            method: "POST",
            body: {
              imageBase64: image.toString("base64"),
              title: "Amazon product image",
              fileName: `amazon-product${extensionForMime(downloaded.mimeType)}`,
              mimeType: downloaded.mimeType,
            },
            signal,
            timeoutMs: 30_000,
          });
          taskId = requireTaskId(created?.task?.id);
          task = created.task;
          if (onTask) await onTask(taskId);
        }
        if (!task?.status || ["pending_review", "failed"].includes(task.status)) {
          // Download/checkpointing may take time; recheck cached local runtime
          // before the one POST that can enqueue a new search. The bridge owns
          // the persisted 90-second / five-search pacing and serial execution.
          requireSearchAllowed(await this.getRuntime({ verify: false, signal }), taskId, { now: this.now(), enqueue: true });
          await this.#confirmTask(taskId, {
            sellingPrice,
            sellingPriceCurrency,
            targetMoq,
            destination,
            signal,
          });
          task = null;
        }
        task = task?.status === "review_candidates" ? task : await this.#waitForTask(taskId, signal);
      } catch (error) {
        throw attachTaskId(error, taskId);
      }
      const imageCandidates = task.candidates.slice(0, MAX_SIMILARITY_CANDIDATES);
      const imageEntries = imageCandidates.map((candidate, index) => ({
        candidate,
        sourceRank: index + 1,
      }));
      const reference = await this.imageReferenceFactory(image);
      const scoredQuotes = await this.#scoreCandidates(imageEntries, {
        reference,
        targetMoq,
        targetUnit,
        signal,
      });
      const result = buildSupplierSearchResult(scoredQuotes, {
        targetMoq,
        targetUnit,
        searchedAt: task.updatedAt,
        selectorVersion: "1688-procurement-assistant-2.3.0",
      });
      return {
        ...result,
        procurementTaskId: taskId,
        procurementTaskReused: Boolean(reusableTaskId),
        searchMode: "image_only",
        searchStrategyVersion: SUPPLIER_SEARCH_STRATEGY_VERSION,
        audit: {
          ...result.audit,
          procurementTaskId: taskId,
          procurementTaskStatus: task.status,
          procurementTaskReused: Boolean(reusableTaskId),
          imageCandidatesReturned: task.candidates.length,
          imageCandidatesCompared: imageCandidates.length,
          imageQualifiedUniqueCount: result.similarity.imageQualifiedCount,
          mergedQualifiedUniqueCount: result.similarity.qualifiedCount,
          finalFallbackEligibleUniqueCount: result.similarity.fallbackCandidateCount,
          finalMergedCandidateCount: imageCandidates.length,
          searchAttempts: reusedCandidates ? 0 : 1,
          searchStrategyVersion: SUPPLIER_SEARCH_STRATEGY_VERSION,
          sharedContext: true,
          onlineAuthRequired: !reusedCandidates,
        },
      };
    } catch (error) {
      throw attachTaskId(error, taskId);
    } finally {
      if (downloaded) await downloaded.cleanup();
    }
  }

  async #scoreCandidates(candidates, {
    reference,
    targetMoq,
    targetUnit,
    signal,
  }) {
    const imageCandidates = candidates.map((entry, index) => {
      const candidate = entry.candidate;
      const supplierName = candidate.supplier?.name || candidate.factoryName;
      const base = {
        rank: index + 1,
        sourceRank: entry.sourceRank,
        searchRank: entry.sourceRank,
        searchSource: "image",
        searchSources: ["image"],
        sourceRanks: { image: entry.sourceRank },
        supplierId: candidate.supplierKey || "",
        supplierName,
        offerId: candidate.offerId,
        offerUrl: candidate.offerUrl || candidate.url,
        price: candidate.price,
        priceText: candidate.priceText,
        moq: targetMoq,
        unit: targetUnit,
        spec: candidate.title || null,
        candidateTitle: candidate.title || null,
        factoryVerified: candidate.verified?.factory === true || candidate.verifiedFactory === true,
        candidateImageUrl: candidate.imageUrl || candidate.image || null,
        comparedAt: this.timestamp(),
      };
      return base;
    });
    return mapWithConcurrency(imageCandidates, IMAGE_COMPARISON_CONCURRENCY, async (base) => {
      if (!base.candidateImageUrl) {
        return {
          ...base,
          imageSimilarityDecision: "unavailable",
          imageSimilarityErrorCode: "CANDIDATE_IMAGE_MISSING",
          supplierMatchDecision: "unavailable",
        };
      }
      try {
        const candidateImage = await this.candidateImageDownloader(base.candidateImageUrl, { signal });
        const comparison = await reference.compare(candidateImage.buffer);
        const score = Number(comparison?.score);
        if (!Number.isFinite(score) || score < 0 || score > 1) {
          return {
            ...base,
            imageSimilarityDecision: "unavailable",
            imageSimilarityErrorCode: "IMAGE_SIMILARITY_SCORE_INVALID",
            supplierMatchDecision: "unavailable",
          };
        }
        const imageEvidence = {
          ...base,
          candidateImageUrl: candidateImage.url || base.candidateImageUrl,
          imageSimilarityScore: score,
          imageSimilarityDecision: score > MIN_IMAGE_SIMILARITY_SCORE ? "passed" : "below_threshold",
          similarityMethod: comparison.method,
          similarityVersion: comparison.version,
          sourceImageSha256: comparison.sourceImageSha256 || reference.sourceImageSha256,
          candidateImageSha256: comparison.candidateImageSha256 || candidateImage.sha256,
          imageSimilarityComponents: comparison.components,
        };
        const imagePassed = score > MIN_IMAGE_SIMILARITY_SCORE;
        return {
          ...imageEvidence,
          supplierMatchDecision: imagePassed ? "passed" : "below_threshold",
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return {
          ...base,
          imageSimilarityDecision: "unavailable",
          imageSimilarityErrorCode: safeComparisonErrorCode(error),
          supplierMatchDecision: "unavailable",
        };
      }
    }, signal);
  }

  async #waitForTask(taskId, signal) {
    const deadline = this.now() + this.searchTimeoutMs;
    while (this.now() < deadline) {
      throwIfAborted(signal);
      const task = await this.#getTask(taskId, signal);
      if (task.status === "review_candidates") return task;
      if (task.status === "failed" || task.status === "risk_blocked") throw taskFailure(task);
      if (!["pending_review", "queued", "running"].includes(task.status)) {
        throw new Procurement1688Error("PROCUREMENT_TASK_STATE_INVALID", `1688 找厂任务状态异常：${task.status || "unknown"}。`, 502, null, { taskId });
      }
      await this.waitImpl(this.pollIntervalMs, signal);
    }
    throw new Procurement1688Error("PROCUREMENT_SEARCH_TIMEOUT", "1688 图片找厂超时；任务已保存在采购助手中，可稍后查看。", 504, null, { taskId });
  }

  async #getTask(taskId, signal) {
    const result = await this.#request(`/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      signal,
      timeoutMs: 15_000,
    });
    const task = result?.task;
    if (!task || task.id !== taskId) {
      throw new Procurement1688Error("PROCUREMENT_RESPONSE_INVALID", "1688 采购助手返回了无效任务。", 502, null, { taskId });
    }
    return task;
  }

  async #confirmTask(taskId, {
    sellingPrice,
    sellingPriceCurrency,
    targetMoq,
    destination,
    signal,
  }) {
    await this.#request(`/api/v1/tasks/${encodeURIComponent(taskId)}/confirm`, {
      method: "POST",
      body: {
        confirmed: true,
        sellingPrice,
        sellingPriceCurrency: currencyCode(sellingPriceCurrency),
        targetQuantity: positiveInteger(targetMoq, "targetMoq"),
        destination: safeDestination(destination),
      },
      signal,
      timeoutMs: 35_000,
    });
  }

  async #assertExpectedService(signal) {
    const checkedAt = this.now();
    if (checkedAt - this.healthCheckedAt >= 0 && checkedAt - this.healthCheckedAt < HEALTH_CACHE_MS) return;
    let health;
    let lastFailure;
    for (let attempt = 1; attempt <= this.healthProbeAttempts; attempt += 1) {
      try {
        health = await this.#request("/api/v1/health", { signal, timeoutMs: 5_000, skipHealth: true });
        break;
      } catch (cause) {
        if (cause instanceof Procurement1688Error && cause.code !== "PROCUREMENT_CONSOLE_UNAVAILABLE") throw cause;
        lastFailure = cause;
        if (attempt < this.healthProbeAttempts) {
          await this.waitImpl(this.healthProbeRetryDelayMs, signal);
        }
      }
    }
    if (!health) {
      throw new Procurement1688Error(
        "PROCUREMENT_CONSOLE_UNAVAILABLE",
        "1688 采购助手未启动，请重新打开找品 Agent。",
        503,
        lastFailure,
      );
    }
    if (
      health?.product !== PROCUREMENT_1688_PRODUCT
      || health?.version !== PROCUREMENT_1688_VERSION
      || health?.loginBrokerProtocol !== PROCUREMENT_1688_BROKER_PROTOCOL
      || health?.integrationProtocol !== PROCUREMENT_1688_INTEGRATION_PROTOCOL
      || health?.capabilities?.imageCandidateLimit !== PROCUREMENT_1688_IMAGE_CANDIDATE_LIMIT
      || health?.capabilities?.supplierStrengthRefresh !== true
      || health?.capabilities?.automaticSupplierStrength !== true
      || health?.capabilities?.imageSearchRiskRecovery !== true
      || health?.capabilities?.excelBatchImport !== true
      || health?.capabilities?.imageSearchWithoutPrice !== true
      || health?.capabilities?.persistentSearchRateLimit !== true
      || health?.capabilities?.manualRiskResume !== true
    ) {
      throw new Procurement1688Error(
        "PROCUREMENT_CONSOLE_IDENTITY_MISMATCH",
        "本机 16880 端口不是指定版本的 1688 采购助手，已停止发送商品数据。",
        503,
      );
    }
    this.healthCheckedAt = checkedAt;
  }

  async #request(pathname, {
    method = "GET",
    body,
    signal,
    timeoutMs = 20_000,
  } = {}) {
    const url = new URL(pathname, PROCUREMENT_1688_ORIGIN);
    let response;
    let lastFailure;
    const attempts = method === "GET" ? SAFE_REQUEST_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: body === undefined ? undefined : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: combineSignals(signal, timeoutMs),
        });
        break;
      } catch (cause) {
        if (signal?.aborted) throw signal.reason || cause;
        lastFailure = cause;
        this.healthCheckedAt = 0;
        if (attempt < attempts) {
          await this.waitImpl(SAFE_REQUEST_RETRY_DELAYS_MS[attempt - 1] || SAFE_REQUEST_RETRY_DELAYS_MS.at(-1), signal);
        }
      }
    }
    if (!response) {
      throw new Procurement1688Error("PROCUREMENT_CONSOLE_UNAVAILABLE", "无法连接本机 1688 采购助手。", 503, lastFailure);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      const code = normalizeUpstreamCode(payload?.error?.code, response.status);
      throw new Procurement1688Error(
        code,
        payload?.error?.message || `1688 采购助手返回 HTTP ${response.status}。`,
        response.status,
        null,
        payload?.error ?? null,
      );
    }
    if (!payload || payload.ok !== true) {
      throw new Procurement1688Error("PROCUREMENT_RESPONSE_INVALID", "1688 采购助手返回了无效响应。", 502);
    }
    return payload;
  }
}

export function requireReadyAuth(auth) {
  if (auth?.ready === true) return auth;
  const reason = String(auth?.reason || "verification_failed");
  const mapping = {
    login_required: ["LOGIN_REQUIRED", "1688 登录已失效，请在专用 Edge 中重新登录。", 401],
    risk_control: ["RISK_CONTROL", "1688 要求人工验证，请在专用 Edge 中处理后重试。", 409],
    rate_limited: ["RATE_LIMITED", "1688 当前访问受限，请稍后在专用 Edge 中确认状态。", 429],
    checking: ["AUTH_CHECKING", "1688 正在进行在线身份验证，请稍后重试。", 409],
    waiting_login: ["AUTH_CHECKING", "请先在已打开的专用 Edge 中完成 1688 登录。", 409],
    verification_failed: ["VERIFICATION_FAILED", "1688 在线身份验证失败，请在专用 Edge 中重新登录。", 401],
  };
  const [code, message, status] = mapping[reason] || mapping.verification_failed;
  throw new Procurement1688Error(code, message, status, null, { auth });
}

function requireSearchAllowed(runtime, taskId, { now, enqueue }) {
  requireReadyAuth(runtime?.auth);
  const policy = runtime?.queue?.ratePolicy;
  if (["SEARCH_TIMEOUT", "SEARCH_WORKER_EXITED", "SEARCH_WORKER_STOP_FAILED", "SEARCH_INTERRUPTED"].includes(policy?.pausedReason)) {
    throw new Procurement1688Error(policy.pausedReason,
      "1688 搜图执行已中断，任务断点已保留。请检查采购服务和浏览器后，明确点击继续。", 409,
      null, { taskId, pausedReason: policy.pausedReason });
  }
  if (policy?.manualResumeRequired === true || (policy?.pausedReason && policy.pausedReason !== "RATE_LIMITED")
    || Number(runtime?.queue?.riskBlocked || 0) > 0) {
    throw new Procurement1688Error(
      "RISK_VERIFICATION_REQUIRED", "1688 账号已登录，但搜图已暂停。请先完成人工图片验证，再点击「验证完成，继续搜图」。", 409,
      null, { taskId },
    );
  }
  const nextAllowedAt = Date.parse(policy?.nextAllowedAt || "");
  if (policy?.pausedReason === "RATE_LIMITED" || (enqueue && Number.isFinite(nextAllowedAt) && nextAllowedAt > now)) {
    throw new Procurement1688Error("RATE_LIMITED", "1688 搜图正在冷却，队列会在等待时间结束后继续。", 429,
      null, { taskId, nextAllowedAt: policy?.nextAllowedAt ?? null });
  }
}

function attachTaskId(error, taskId) {
  if (!taskId || !(error instanceof Error)) return error;
  if (error instanceof Procurement1688Error) {
    error.details = { ...(error.details || {}), taskId };
    return error;
  }
  return new Procurement1688Error(
    "PROCUREMENT_TASK_INTERRUPTED",
    error.message || "1688 找厂任务已中断，可使用已保存的任务继续。",
    503,
    error,
    { taskId },
  );
}

function taskFailure(task) {
  const upstreamCode = String(task.failure?.code || (task.status === "risk_blocked" ? "RISK_CONTROL" : "SEARCH_FAILED")).toUpperCase();
  const mapped = {
    AUTH_REQUIRED: "LOGIN_REQUIRED",
    NOT_LOGGED_IN: "LOGIN_REQUIRED",
    RISK_VERIFICATION_REQUIRED: "RISK_CONTROL",
    RISK_CONTROL: "RISK_CONTROL",
    RATE_LIMITED: "RATE_LIMITED",
    SESSION_BUSY: "SESSION_BUSY",
  }[upstreamCode] || upstreamCode;
  const status = mapped === "RATE_LIMITED" ? 429 : mapped === "LOGIN_REQUIRED" ? 401 : mapped === "RISK_CONTROL" || mapped === "SESSION_BUSY" ? 409 : 502;
  return new Procurement1688Error(mapped, task.failure?.message || "1688 图片找厂失败。", status, null, { taskId: task.id });
}

function loginPurpose(value) {
  if (value === "login" || value === "image_search") return value;
  throw new Procurement1688Error(
    "LOGIN_PURPOSE_INVALID",
    "1688 登录窗口用途必须是 login 或 image_search。",
    422,
  );
}

function normalizeUpstreamCode(code, status) {
  const normalized = String(code || "").trim().toUpperCase();
  if (normalized === "NOT_LOGGED_IN" || normalized === "AUTH_REQUIRED") return "LOGIN_REQUIRED";
  if (/RISK|CAPTCHA|PUNISH|VERIFY/.test(normalized)) return "RISK_CONTROL";
  if (normalized === "RATE_LIMITED" || status === 429) return "RATE_LIMITED";
  return /^[A-Z0-9_-]{1,100}$/.test(normalized) ? normalized : "PROCUREMENT_UPSTREAM_ERROR";
}

function safeComparisonErrorCode(error) {
  const code = String(error?.code || error?.name || "IMAGE_SIMILARITY_UNAVAILABLE").trim().toUpperCase();
  return /^[A-Z0-9_-]{1,100}$/.test(code) ? code : "IMAGE_SIMILARITY_UNAVAILABLE";
}

function requireTaskId(value) {
  const taskId = String(value || "");
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    throw new Procurement1688Error("PROCUREMENT_RESPONSE_INVALID", "1688 采购助手未返回有效任务编号。", 502);
  }
  return taskId;
}

function compareProcurementQueueOrder(left, right) {
  return Number(left?.queueSequence || Number.MAX_SAFE_INTEGER)
    - Number(right?.queueSequence || Number.MAX_SAFE_INTEGER)
    || String(left?.updatedAt || "").localeCompare(String(right?.updatedAt || ""));
}

function summarizeActiveTask(task) {
  const status = String(task?.status || "");
  if (!["queued", "running", "risk_blocked"].includes(status)) {
    throw new Procurement1688Error("PROCUREMENT_RESPONSE_INVALID", "1688 采购助手返回了无效的活动任务状态。", 502);
  }
  const queueSequence = Number(task?.queueSequence);
  const summary = {
    id: requireTaskId(task?.id),
    status,
    title: safeTaskTitle(task?.title),
    updatedAt: String(task?.updatedAt || ""),
  };
  if (Number.isInteger(queueSequence) && queueSequence > 0) summary.queueSequence = queueSequence;
  if (status === "risk_blocked") {
    summary.code = String(task?.failure?.code || "RISK_VERIFICATION_REQUIRED");
    summary.message = String(task?.failure?.message || "1688 图片搜索需要人工验证。");
  }
  return summary;
}

function optionalPositiveNumber(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Procurement1688Error("PROCUREMENT_INPUT_INVALID", `${label} 必须大于 0。`, 422);
  return number;
}

function positiveInteger(value, label) {
  const number = Math.trunc(Number(value));
  if (!Number.isInteger(number) || number < 1 || number > 1_000_000) {
    throw new Procurement1688Error("PROCUREMENT_INPUT_INVALID", `${label} 必须是 1 到 1000000 的整数。`, 422);
  }
  return number;
}

function currencyCode(value) {
  const currency = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Procurement1688Error("PROCUREMENT_INPUT_INVALID", "售价币种无效。", 422);
  return currency;
}

function safeTaskTitle(value) {
  const title = String(value || "Amazon product").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return [...(title || "Amazon product")].slice(0, 200).join("");
}

function safeDestination(value) {
  const destination = String(value || "Amazon 商品成本估算").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const safe = [...destination].slice(0, 80).join("");
  return safe.startsWith("--") ? `Amazon ${safe}` : safe || "Amazon 商品成本估算";
}

function extensionForMime(mimeType) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  return ".jpg";
}

function combineSignals(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
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

function abortableDelay(milliseconds, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason || new DOMException("The operation was aborted.", "AbortError"));
    };
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("The operation was aborted.", "AbortError");
}
