#!/usr/bin/env node
// 1688 采购助手桥接服务（1688-procurement-assistant 2.3.0 兼容实现）
//
// 作用：在 127.0.0.1:16880 提供店铺分析 Agent（scout-amazon-agent）期望的
// /api/v1 集成协议（integrationProtocol 8 / loginBrokerProtocol 5）：
//   GET  /api/v1/health              服务身份握手
//   GET  /api/v1/runtime[?verify=1]  登录态 + 任务队列概览
//   POST /api/v1/auth/open-login     打开专用 Edge（扫码登录 / 图片搜索人工验证）
//   POST /api/v1/queue/resume        人工验证成功后明确恢复搜图队列
//   POST /api/v1/tasks               用图片创建找厂任务
//   GET  /api/v1/tasks               任务列表
//   GET  /api/v1/tasks/:id           任务详情（轮询）
//   POST /api/v1/tasks/:id/confirm   确认任务并排队执行
//
// 浏览器能力使用独立的 1688-image-finder 专用 Edge 会话。
// 安装包通过环境变量指定组件与数据路径；未配置时保留旧安装的会话位置。
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ImageSearchRatePolicy, classifySearchFailure, isSearchExecutionPause } from "./lib/image-search-rate-policy.mjs";
import { resolve1688RuntimePaths } from "./lib/runtime-paths.mjs";
import { runImageSearchProcess, hasActiveSearchProcess, SEARCH_EXECUTION_TIMEOUT_MS } from "./lib/image-search-process.mjs";

const HOST = "127.0.0.1";
const PORT = 16880;
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const runtimePaths = resolve1688RuntimePaths({ projectRoot: PROJECT_ROOT });
const IMAGE_FINDER_ROOT = runtimePaths.imageFinderRoot;
const BB1688_HOME = runtimePaths.sessionRoot;
const DATA_ROOT = runtimePaths.dataRoot;
const CLI_ENTRY = path.join(IMAGE_FINDER_ROOT, "dist", "cli.js");

// Set the dedicated session before importing browser modules. Child processes
// inherit the same explicit location; no logged-in profile is moved or copied.
process.env.BB1688_HOME = BB1688_HOME;
process.env.BB1688_DATA_ROOT = DATA_ROOT;

const HANDSHAKE_DIR = path.join(DATA_ROOT, "runtime-cache", "login-handshakes");
const TASK_IMAGE_DIR = path.join(DATA_ROOT, "runtime-cache", "task-images");
const TASKS_DIR = path.join(DATA_ROOT, "tasks");
const LOG_DIR = path.join(DATA_ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "service.log");

const PRODUCT = "1688-procurement-assistant";
const VERSION = "2.3.0";
const LOGIN_BROKER_PROTOCOL = 5;
const INTEGRATION_PROTOCOL = 8;
const IMAGE_CANDIDATE_LIMIT = 40;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const LOGIN_READY_TIMEOUT_MS = 40_000;
const VERIFY_TTL_MS = 5 * 60_000;
const SEARCH_MAX_OFFERS = 40;

const startedAtIso = new Date().toISOString();
// 保守的任务频率策略；不代表测得的 1688 HTTP 安全请求阈值。
const searchPolicy = new ImageSearchRatePolicy({
  file: path.join(DATA_ROOT, "runtime-cache", "image-search-rate-policy.json"),
  minGapMs: process.env.BB1688_SEARCH_MIN_GAP_MS,
  cooldownMs: process.env.BB1688_SEARCH_COOLDOWN_MS,
});

// ── CLI 会话模块（延迟动态导入：必须先设好 BB1688_HOME） ──────────────────
const importCli = (rel) => import(pathToFileURL(path.join(IMAGE_FINDER_ROOT, "dist", rel)).href);
const [{ withSession }, { readState, writeState }, { parseIdentity }, { verifyOnlineStatus }, { CliError }, { detectProcurementImageType }] =
  await Promise.all([
    importCli("session/context.js"),
    importCli("session/state.js"),
    importCli("auth/cookies.js"),
    importCli("auth/verify.js"),
    importCli("io/errors.js"),
    importCli("procurement/store.js"),
  ]);

// ── 日志 ─────────────────────────────────────────────────────────────────
let logWriteQueue = Promise.resolve();
async function appendLog(line) {
  logWriteQueue = logWriteQueue.then(async () => {
    try {
      await fsp.mkdir(LOG_DIR, { recursive: true });
      const stat = await fsp.stat(LOG_FILE).catch(() => null);
      if (stat && stat.size > 2 * 1024 * 1024) {
        const buf = await fsp.readFile(LOG_FILE);
        await fsp.writeFile(LOG_FILE, buf.subarray(Math.max(0, buf.length - 512 * 1024)));
      }
      await fsp.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
    } catch {
      /* 日志失败不影响服务 */
    }
  });
  await logWriteQueue;
}
function log(message) {
  const text = typeof message === "string" ? message : JSON.stringify(message);
  process.stdout.write(`${text}\n`).catch?.(() => {});
  void appendLog(text);
}

// ── API 错误 ─────────────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ── 浏览器操作串行队列 ───────────────────────────────────────────────────
let lastBrowserOp = Promise.resolve();
function runBrowserOp(operation) {
  const result = lastBrowserOp.then(operation, operation);
  lastBrowserOp = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// ── 登录态管理 ───────────────────────────────────────────────────────────
const auth = {
  ready: false,
  reason: "login_required",
  message: "尚未登录 1688",
  memberId: null,
  nick: null,
  checking: false,
  loggedInAt: null,
  lastVerifiedAt: null,
  checkedAt: null,
};
let lastVerifyOkAt = 0;

function authReasonText(reason) {
  const mapping = {
    login_required: "1688 未登录，点击右侧按钮打开专用 Edge 扫码",
    risk_control: "1688 要求人工验证，请在专用 Edge 中完成",
    rate_limited: "1688 访问受限，请稍后再试",
    checking: "正在校验 1688 登录状态",
    waiting_login: "专用 Edge 已打开，等待扫码登录",
    verification_failed: "1688 在线校验未通过，请重新扫码登录",
  };
  return mapping[reason] || "1688 登录状态未知，请重新验证";
}

async function loadAuthFromDisk() {
  let state = { version: 1 };
  try {
    state = await readState("default");
  } catch (error) {
    log(`读取会话状态失败：${error?.message || error}`);
  }
  auth.memberId = typeof state.memberId === "string" && state.memberId ? state.memberId : null;
  auth.nick = typeof state.nick === "string" && state.nick ? state.nick : null;
  auth.loggedInAt = state.loggedInAt ?? null;
  auth.lastVerifiedAt = state.lastVerifiedAt ?? null;
  if (auth.memberId) {
    auth.ready = true;
    auth.reason = "ready";
    auth.message = `1688 已登录：${auth.nick ?? auth.memberId}`;
  } else {
    auth.ready = false;
    auth.reason = "login_required";
    auth.message = authReasonText("login_required");
  }
}

async function verifyNow({ force = false } = {}) {
  if (searchPolicy.view().manualResumeRequired || searchPolicy.waitMs() > 0) return publicAuth();
  if (loginChildAlive()) {
    auth.reason = "waiting_login";
    auth.message = authReasonText("waiting_login");
    return publicAuth();
  }
  if (!force && auth.ready && Date.now() - lastVerifyOkAt < VERIFY_TTL_MS) {
    return publicAuth();
  }
  if (!auth.memberId) await loadAuthFromDisk();
  if (!auth.memberId) return publicAuth();

  auth.checking = true;
  try {
    const outcome = await withSession({ headless: true, profile: "default" }, async (ctx) => {
      const identity = parseIdentity(await ctx.cookies());
      if (!identity) return { ok: false, reason: "login_required", identity: null };
      const status = await verifyOnlineStatus(ctx);
      return { ...status, identity };
    });
    auth.checkedAt = new Date().toISOString();
    if (outcome.ok) {
      auth.ready = true;
      auth.reason = "ready";
      auth.memberId = outcome.identity.memberId;
      if (outcome.identity.nick) auth.nick = outcome.identity.nick;
      auth.message = `1688 已登录：${auth.nick ?? auth.memberId}`;
      lastVerifyOkAt = Date.now();
      const state = await readState("default").catch(() => ({ version: 1 }));
      await writeState({
        ...state,
        version: 1,
        memberId: auth.memberId,
        nick: auth.nick ?? undefined,
        loggedInAt: state.loggedInAt ?? auth.checkedAt,
        lastVerifiedAt: auth.checkedAt,
      }, "default").catch(() => undefined);
      log(`1688 在线校验通过：${auth.nick ?? auth.memberId}`);
    } else {
      auth.ready = false;
      auth.reason = outcome.reason || "verification_failed";
      auth.message = authReasonText(auth.reason);
      log(`1688 在线校验未通过：${auth.reason}`);
    }
  } catch (error) {
    auth.checkedAt = new Date().toISOString();
    if (isLockBusyError(error)) {
      auth.ready = Boolean(auth.memberId);
      auth.reason = loginChildAlive() ? "waiting_login" : "checking";
      auth.message = loginChildAlive() ? authReasonText("waiting_login") : "1688 会话正忙，请稍后重试";
    } else {
      auth.ready = false;
      auth.reason = "verification_failed";
      auth.message = `1688 在线校验失败：${shortMessage(error)}`;
      log(`1688 在线校验异常：${error?.stack || error}`);
    }
  } finally {
    auth.checking = false;
  }
  return publicAuth();
}

function publicAuth() {
  return {
    ready: auth.ready,
    reason: auth.reason,
    message: auth.message,
    memberId: auth.memberId,
    nick: auth.nick,
    checking: auth.checking,
    windowOpen: loginChildAlive(),
    imageSearchPhase: loginChild?.purpose === "image_search" ? loginChild.imageSearchPhase ?? null : null,
    lastWindowError: lastWindowError ? { ...lastWindowError } : null,
    loggedInAt: auth.loggedInAt,
    lastVerifiedAt: auth.lastVerifiedAt,
    checkedAt: auth.checkedAt,
  };
}

// ── 找厂任务存储 ─────────────────────────────────────────────────────────
/** @type {Map<string, any>} */
const tasks = new Map();
const taskQueue = [];
let queueSequence = 0;
let runningTaskId = null;
let workerPumping = false;
let queueReady = false;
let queueWakeTimer = null;

function taskFile(id) {
  return path.join(TASKS_DIR, `${encodeURIComponent(id)}.json`);
}

async function persistTask(task) {
  task.updatedAt = new Date().toISOString();
  await fsp.mkdir(TASKS_DIR, { recursive: true });
  await fsp.writeFile(taskFile(task.id), JSON.stringify(task, null, 2));
}

async function loadTasksFromDisk() {
  await fsp.mkdir(TASKS_DIR, { recursive: true });
  const entries = await fsp.readdir(TASKS_DIR).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fsp.readFile(path.join(TASKS_DIR, entry), "utf8");
      const task = JSON.parse(raw);
      if (!task?.id || typeof task.status !== "string") continue;
      queueSequence = Math.max(queueSequence, Number(task.queueSequence) || 0);
      if (task.status === "running") {
        // A service exit cannot prove whether an upload/search already reached
        // 1688. Keep this checkpoint for inspection instead of submitting twice.
        task.status = "failed";
        task.failure = { code: "SEARCH_INTERRUPTED", message: "上次搜图随服务中断，结果尚未确认，请检查后再继续。" };
        tasks.set(task.id, task);
        await persistTask(task);
      } else {
        tasks.set(task.id, task);
      }
    } catch (error) {
      log(`任务文件 ${entry} 读取失败：${shortMessage(error)}`);
    }
  }
  taskQueue.push(...[...tasks.values()].filter(task => task.status === "queued")
    .sort((left, right) => Number(left.queueSequence || 0) - Number(right.queueSequence || 0)).map(task => task.id));
}

function enqueueTask(taskId, { front = false } = {}) {
  if (!taskQueue.includes(taskId)) {
    if (front) taskQueue.unshift(taskId);
    else taskQueue.push(taskId);
  }
  void pumpQueue();
}

async function pumpQueue() {
  if (workerPumping || !queueReady) return;
  workerPumping = true;
  try {
    while (taskQueue.length > 0) {
      const policy = searchPolicy.view();
      // A failed result write retains its reservation. Never spin/requeue it.
      if (policy.manualResumeRequired || policy.rateTrial?.activeSearch || hasActiveSearchProcess()) break;
      if (loginChildAlive() || loginLaunchPending) break; // 专用 Edge 被登录/验证占用时暂停出队，避免会话锁冲突
      const waitMs = searchPolicy.waitMs();
      if (waitMs > 0) {
        scheduleQueueWake(waitMs);
        break;
      }
      const taskId = taskQueue.shift();
      if (tasks.get(taskId)?.status !== "queued") continue;
      runningTaskId = taskId;
      try {
        await runBrowserOp(() => executeTask(taskId));
      } catch (error) {
        log(`任务 ${taskId} 执行异常：${error?.stack || error}`);
        const task = tasks.get(taskId);
        if (task && !["review_candidates", "risk_blocked"].includes(task.status)) {
          task.status = "failed";
          task.failure = { code: "SEARCH_FAILED", message: shortMessage(error) };
          await persistTask(task).catch(() => undefined);
        }
      } finally {
        runningTaskId = null;
      }
    }
  } finally {
    workerPumping = false;
  }
}

function cancelQueueWake() {
  if (queueWakeTimer) clearTimeout(queueWakeTimer);
  queueWakeTimer = null;
}

function scheduleQueueWake(waitMs) {
  cancelQueueWake();
  // Only ordinary pacing / HTTP 429 can wake the queue. Manual pauses never do.
  queueWakeTimer = setTimeout(() => {
    queueWakeTimer = null;
    void pumpQueue();
  }, Math.min(waitMs, 2_147_483_647));
}

async function executeTask(taskId) {
  const task = tasks.get(taskId);
  if (!task || task.status !== "queued") return;
  if (loginChildAlive() || hasActiveSearchProcess() || !(await searchPolicy.beginSearch({ taskId }))) {
    enqueueTask(taskId, { front: true });
    return;
  }
  try {
    task.status = "running";
    task.searchStartedAt = new Date().toISOString();
    task.failure = null;
    task.execution = { startedAt: task.searchStartedAt,
      deadlineAt: new Date(Date.now() + SEARCH_EXECUTION_TIMEOUT_MS).toISOString(), phase: "starting" };
    await persistTask(task);
    log(`任务 ${taskId} 开始以图搜款（image=${task.fileName}）`);
    try {
      const data = await runImageSearchProcess({
        imageFinderRoot: IMAGE_FINDER_ROOT, imagePath: task.imageFile, max: SEARCH_MAX_OFFERS,
        onProgress: progress => { task.execution.phase = progress.phase; },
      });
      const offers = Array.isArray(data?.offers) ? data.offers : [];
      task.candidates = offers.map(mapOfferToCandidate);
      task.imageId = data?.imageId ?? null;
      task.status = "review_candidates";
      task.failure = null;
      log(`任务 ${taskId} 完成：候选 ${task.candidates.length} 条（imageId=${task.imageId ?? "n/a"}）`);
    } catch (error) {
      await applyTaskError(task, error);
      log(`任务 ${taskId} 失败：${task.failure?.code} ${task.failure?.message}`);
    }
    task.execution = { ...task.execution, finishedAt: new Date().toISOString(), phase: "finished" };
    await persistTask(task);
  } finally {
    try {
      await searchPolicy.finishSearch({
        taskId, success: task.status === "review_candidates", code: task.failure?.code ?? null,
      });
    } catch (error) {
      // pauseForManual blocks in memory even if the disk is still unavailable.
      await searchPolicy.pauseForManual("RATE_TRIAL_RECORD_FAILED", taskId).catch(pauseError => {
        log(`速率试验暂停记录写入失败：${shortMessage(pauseError)}`);
      });
      throw error;
    }
  }
}

async function applyTaskError(task, error) {
  const code = String(error?.code || "").toUpperCase();
  const classification = classifySearchFailure(error);
  if (isSearchExecutionPause(code)) {
    task.status = "failed";
    task.failure = { code, message: shortMessage(error) };
    cancelQueueWake();
    await searchPolicy.pauseForManual(code, task.id);
    return;
  }
  if (classification === "manual") {
    task.status = "risk_blocked";
    task.failure = { code: "RISK_VERIFICATION_REQUIRED", message: shortMessage(error) || "1688 要求人工滑块验证。" };
    cancelQueueWake();
    await searchPolicy.pauseForManual("RISK_VERIFICATION_REQUIRED", task.id);
    return;
  }
  if (classification === "rate") {
    await searchPolicy.rateLimit(error);
    task.rateLimitAttempts = (Number(task.rateLimitAttempts) || 0) + 1;
    task.status = task.rateLimitAttempts < 3 ? "queued" : "failed";
    task.failure = { code: "RATE_LIMITED", message: "1688 返回限流，队列已按 Retry-After 或至少 5 分钟暂停。" };
    if (task.status === "queued") enqueueTask(task.id, { front: true });
    return;
  }
  if (error instanceof CliError || code) {
    if (classification === "login") {
      auth.ready = false;
      auth.reason = "login_required";
      auth.message = authReasonText("login_required");
      lastVerifyOkAt = 0;
      task.status = "failed";
      task.failure = { code: "AUTH_REQUIRED", message: "1688 登录已失效，请重新扫码登录后重试。" };
      cancelQueueWake();
      await searchPolicy.pauseForManual("AUTH_REQUIRED", task.id);
      return;
    }
    if (code === "LOCK_BUSY" || code === "CANCELED") {
      task.status = "failed";
      task.failure = { code: "SESSION_BUSY", message: "专用 Edge 正被其他操作占用，请稍后重试。" };
      return;
    }
    task.status = "failed";
    task.failure = { code: code && /^[A-Z0-9_-]{1,100}$/.test(code) ? code : "SEARCH_FAILED", message: shortMessage(error) };
    return;
  }
  task.status = "failed";
  task.failure = { code: "SEARCH_FAILED", message: shortMessage(error) };
}

function mapOfferToCandidate(offer) {
  const supplier = offer?.supplier ?? {};
  const offerId = String(offer?.offerId ?? "");
  const url = String(offer?.url || (offerId ? `https://detail.1688.com/offer/${offerId}.html` : ""));
  const supplierId = supplier.memberId || supplier.loginId || (offerId ? `offer-${offerId}` : "");
  return {
    offerId,
    url,
    offerUrl: url,
    title: offer?.title ?? null,
    price: Number.isFinite(offer?.price?.min) ? offer.price.min : null,
    priceText: offer?.price?.text ?? "",
    supplierKey: supplierId,
    factoryName: supplier.name ?? null,
    supplier: {
      name: supplier.name ?? null,
      years: Number.isFinite(supplier.years) ? supplier.years : null,
      shopUrl: supplier.shopUrl ?? null,
      loginId: supplier.loginId ?? null,
      memberId: supplier.memberId ?? null,
    },
    verified: {
      factory: offer?.verified?.factory === true,
      business: offer?.verified?.business === true,
      superFactory: offer?.verified?.superFactory === true,
    },
    imageUrl: offer?.image ?? null,
    image: offer?.image ?? null,
    location: offer?.location ?? null,
    turnover: offer?.turnover ?? null,
    demand: offer?.demand ?? null,
    isP4P: offer?.isP4P === true,
  };
}

function summarizeTask(task) {
  const summary = {
    id: task.id,
    status: task.status,
    title: sanitizeSingleLine(task.title, 200) || "Amazon product",
    updatedAt: task.updatedAt,
    queueSequence: Number(task.queueSequence) || 0,
  };
  if (task.status === "risk_blocked") {
    summary.code = task.failure?.code || "RISK_VERIFICATION_REQUIRED";
    summary.message = task.failure?.message || "1688 图片搜索需要人工验证。";
  }
  return summary;
}

function queueSummary() {
  const counts = { queued: 0, running: 0, riskBlocked: 0 };
  const activeTasks = [];
  for (const task of tasks.values()) {
    if (task.status === "queued") counts.queued += 1;
    else if (task.status === "running") counts.running += 1;
    else if (task.status === "risk_blocked") counts.riskBlocked += 1;
    else continue;
    activeTasks.push(summarizeTask(task));
  }
  activeTasks.sort((left, right) =>
    left.queueSequence - right.queueSequence
    || String(left.updatedAt).localeCompare(String(right.updatedAt)));
  return {
    ...counts,
    running: Math.max(counts.running, hasActiveSearchProcess() ? 1 : 0),
    activeTasks,
    waitingLogin: loginChildAlive(),
    riskAutoRetryAt: null,
    ratePolicy: searchPolicy.view(),
  };
}

function publicTask(task) {
  return {
    id: task.id,
    status: task.status,
    title: task.title ?? null,
    fileName: task.fileName ?? null,
    mimeType: task.mimeType ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    queueSequence: task.queueSequence,
    confirmedAt: task.confirmedAt ?? null,
    search: task.search ?? null,
    imageId: task.imageId ?? null,
    candidates: Array.isArray(task.candidates) ? task.candidates : [],
    failure: task.failure ?? null,
    execution: task.execution ?? null,
  };
}

// ── 扫码登录子进程（broker 模式） ────────────────────────────────────────
let loginChild = null;
let loginLaunchPending = null;
let latestLoginAttemptId = null;
let lastWindowError = null;
const IMAGE_SEARCH_PHASE_LINE = /^\[image-search-verification\] (waiting_upload_page|upload_control_ready|image_selected_waiting_result|waiting_manual_verification|verified_result)$/;
const MAX_LOGIN_STDERR_LINE = 256;

function receiveLoginStderr(entry, text, { flush = false } = {}) {
  entry.stderrTail = `${entry.stderrTail}${text.slice(-4000)}`.slice(-4000);
  const finishLine = () => {
    if (!entry.stderrLineOverflow) {
      const phase = IMAGE_SEARCH_PHASE_LINE.exec(entry.stderrLine.trim())?.[1];
      if (phase && entry.purpose === "image_search" && !entry.canceled && latestLoginAttemptId === entry.attemptId
        && phase !== entry.imageSearchPhase) {
        entry.imageSearchPhase = phase;
        // Only fixed whitelist values are logged; arbitrary stderr and error details stay private.
        log(`[image-search-verification] ${phase} attempt=${entry.attemptId}`);
      }
    }
    entry.stderrLine = "";
    entry.stderrLineOverflow = false;
  };
  for (const character of text) {
    if (character === "\n") finishLine();
    else if (!entry.stderrLineOverflow) {
      if (entry.stderrLine.length < MAX_LOGIN_STDERR_LINE) entry.stderrLine += character;
      else { entry.stderrLine = ""; entry.stderrLineOverflow = true; }
    }
  }
  if (flush) finishLine();
}

function recordLoginWindowError(entry, fallbackMessage = "1688 验证窗口未成功完成，请重试。") {
  if (entry.canceled || latestLoginAttemptId !== entry.attemptId) return;
  const parsed = parseCliError(entry.stderrTail);
  lastWindowError = {
    code: /^[A-Z0-9_-]{1,100}$/.test(parsed.code) ? parsed.code : "LOGIN_START_FAILED",
    message: sanitizeSingleLine(parsed.message || fallbackMessage, 300),
  };
}

function loginChildAlive() {
  if (!loginChild) return false;
  const { child } = loginChild;
  return child.exitCode === null && child.signalCode === null;
}

async function cancelLoginChild({ reason = "new login request" } = {}) {
  const current = loginChild;
  if (!current) return;
  current.canceled = true;
  log(`取消当前登录子进程（${reason}）：attempt=${current.attemptId}`);
  await fsp.writeFile(current.cancelPath, current.token, { encoding: "ascii" }).catch(() => undefined);
  await waitForChildExit(current.child, 10_000).catch(async () => {
    try {
      current.child.kill();
    } catch {
      /* ignore */
    }
    await waitForChildExit(current.child, 5_000);
  });
  if (loginChild === current) loginChild = null;
  await cleanupHandshake(current).catch(() => undefined);
}

function spawnLoginChild({ purpose, taskId = null }) {
  const token = crypto.randomBytes(32).toString("hex");
  const attemptId = `${Date.now()}-${crypto.randomUUID()}`;
  const readyPath = path.join(HANDSHAKE_DIR, `launch-${attemptId}.ready`);
  const cancelPath = path.join(HANDSHAKE_DIR, `launch-${attemptId}.cancel`);
  const env = {
    ...process.env,
    BB1688_HOME,
    BB1688_LOGIN_ATTEMPT: "1",
    BB1688_LOGIN_TOKEN: token,
    BB1688_LOGIN_READY: readyPath,
    BB1688_LOGIN_CANCEL: cancelPath,
  };
  const args = [CLI_ENTRY, "login", "--open-browser", "--purpose", purpose, "--json", "--timeout", "900"];
  if (purpose === "image_search") {
    const task = tasks.get(taskId);
    env.BB1688_IMAGE_SEARCH_PATH = task.imageFile;
    env.BB1688_IMAGE_SEARCH_MIME = task.mimeType;
    env.BB1688_IMAGE_SEARCH_SHA256 = task.imageSha256;
  }
  log(`启动登录子进程：purpose=${purpose} attempt=${attemptId}`);
  const child = spawn(process.execPath, args, {
    cwd: IMAGE_FINDER_ROOT,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entry = { child, token, attemptId, readyPath, cancelPath, purpose, taskId, readySeen: false,
    stderrTail: "", stderrLine: "", stderrLineOverflow: false, stderrDecoder: new StringDecoder("utf8"), imageSearchPhase: null };
  latestLoginAttemptId = attemptId;
  lastWindowError = null;
  loginChild = entry;
  child.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    if (/alreadyLoggedIn|memberId/.test(text)) log(`登录子进程输出：${text.trim().slice(0, 500)}`);
  });
  child.stderr?.on("data", (chunk) => {
    receiveLoginStderr(entry, typeof chunk === "string" ? chunk : entry.stderrDecoder.write(chunk));
  });
  child.stderr?.once("end", () => {
    receiveLoginStderr(entry, entry.stderrDecoder.end(), { flush: true });
  });
  child.once("error", (error) => {
    entry.spawnError = error;
    recordLoginWindowError(entry, `1688 登录窗口启动失败：${shortMessage(error)}`);
    if (loginChild === entry) loginChild = null;
    void cleanupHandshake(entry);
    log(`登录子进程启动失败：${shortMessage(error)}`);
  });
  child.once("exit", (code, signal) => {
    if (code !== 0) recordLoginWindowError(entry);
    else if (!entry.canceled && latestLoginAttemptId === entry.attemptId) lastWindowError = null;
    if (loginChild === entry) loginChild = null;
    void cleanupHandshake(entry).catch(() => undefined);
    void (async () => {
      if (code === 0 && !entry.canceled && latestLoginAttemptId === entry.attemptId) {
        await loadAuthFromDisk();
        lastVerifyOkAt = Date.now(); // 子进程已完成在线校验
        log(`登录子进程成功退出：purpose=${entry.purpose}`);
        if (await searchPolicy.markManualVerification({ purpose: entry.purpose })) {
          log("人工验证完成，搜图队列仍暂停，等待用户明确继续。");
        }
      } else {
        log(`登录子进程退出：code=${code} signal=${signal} attempt=${entry.attemptId}`);
        if (!entry.canceled && latestLoginAttemptId === entry.attemptId && entry.purpose === "image_search" && entry.taskId && code !== 0) {
          const task = tasks.get(entry.taskId);
          if (task && task.status === "queued") {
            // 验证被取消/失败：保持 risk_blocked 语义，便于再次发起专项验证
            task.status = "risk_blocked";
            task.failure = task.failure || { code: "RISK_VERIFICATION_REQUIRED", message: "图片搜索验证未完成，请重试。" };
            cancelQueueWake();
            await searchPolicy.pauseForManual("RISK_VERIFICATION_REQUIRED", task.id);
            await persistTask(task).catch(() => undefined);
          }
        }
      }
      void pumpQueue();
    })().catch(error => log(`处理登录结果失败：${shortMessage(error)}`));
  });
  // Child exit can precede the last stderr chunk. Capture the final parsed
  // error after its streams close, without letting an old attempt overwrite a new one.
  child.once("close", (code) => {
    if (code !== 0) recordLoginWindowError(entry);
  });
  return entry;
}

async function cleanupHandshake(entry) {
  await fsp.rm(entry.readyPath, { force: true }).catch(() => undefined);
  await fsp.rm(entry.cancelPath, { force: true }).catch(() => undefined);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待子进程退出超时")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForLoginReady(entry, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entry.readySeen) return true;
    const stat = await fsp.stat(entry.readyPath).then(() => true, () => false);
    if (stat) {
      entry.readySeen = true;
      return true;
    }
    if (entry.spawnError || childHasExited(entry.child)) return false;
    await delay(200);
  }
  return Boolean(entry.readySeen);
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function openLogin({ restart, purpose, taskId }) {
  if (hasActiveSearchProcess() && !runningTaskId) {
    throw new ApiError(409, "SEARCH_WORKER_STOP_FAILED", "搜图工作进程尚未确认退出，请先检查服务。");
  }
  const deadline = Date.now() + LOGIN_READY_TIMEOUT_MS;
  if (purpose === "image_search" && !tasks.has(taskId)) {
    throw new ApiError(404, "PROCUREMENT_TASK_NOT_FOUND", "未找到对应的 1688 找厂任务。");
  }
  if (loginChildAlive()) {
    if (!restart) {
      const current = loginChild;
      const ready = current.readySeen || await waitForLoginReady(current, Math.min(15_000, deadline - Date.now()));
      if (ready || (!current.spawnError && !childHasExited(current.child))) return loginWindowPayload(current, ready, true);
    }
    await cancelLoginChild({ reason: `restart=${restart === true}` });
  }
  // 等待正在进行的浏览器操作（在线校验/搜索）释放会话锁，避免子进程 LOCK_BUSY
  if (!loginLaunchPending) {
    const pending = runBrowserOp(() => spawnLoginChild({ purpose, taskId }));
    loginLaunchPending = pending;
    void pending.finally(() => { if (loginLaunchPending === pending) loginLaunchPending = null; }).catch(() => {});
  }
  let timeout;
  const entry = await Promise.race([
    loginLaunchPending,
    new Promise(resolve => { timeout = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); }),
  ]).finally(() => clearTimeout(timeout));
  if (!entry) return { ok: true, pending: true, edgeReady: false, alreadyRunning: false, purpose, auth: publicAuth(), memberId: auth.memberId, nick: auth.nick };
  const ready = await waitForLoginReady(entry, Math.max(0, deadline - Date.now()));
  if (!ready) {
    // Slow navigation can outlive the API budget. Keep the live process and
    // handshakes so the next request reuses it instead of orphaning a window.
    if (!entry.spawnError && !childHasExited(entry.child)) return loginWindowPayload(entry, false, false);
    let failureCode = "LOGIN_WINDOW_TIMEOUT";
    let failureMessage = "1688 专用 Edge 未能创建可见窗口，请重试。";
    if (entry.spawnError || childHasExited(entry.child)) {
      const parsed = parseCliError(entry.stderrTail);
      failureCode = parsed.code || "LOGIN_START_FAILED";
      failureMessage = parsed.message || `1688 登录窗口启动失败（退出码 ${entry.child.exitCode ?? "?"}）。`;
    }
    if (loginChild === entry) loginChild = null;
    await cleanupHandshake(entry).catch(() => undefined);
    log(`打开专用 Edge 失败：${failureCode} ${failureMessage}`);
    throw new ApiError(502, failureCode, failureMessage);
  }
  log(`专用 Edge 已打开：purpose=${purpose}`);
  return loginWindowPayload(entry, true, false);
}

function loginWindowPayload(entry, ready, alreadyRunning) {
  return { ok: true, pending: !ready, edgeReady: ready, alreadyRunning,
    purpose: entry.purpose, taskId: entry.taskId, auth: publicAuth(),
    memberId: auth.memberId, nick: auth.nick };
}

function parseCliError(stderrTail) {
  const lines = String(stderrTail || "").split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed?.ok === false && parsed?.code) {
        return { code: String(parsed.code).toUpperCase(), message: String(parsed.message || "") };
      }
    } catch {
      /* not json */
    }
  }
  const match = /error: (.+)/i.exec(String(stderrTail || ""));
  return match ? { code: "", message: match[1].slice(0, 300) } : { code: "", message: "" };
}

// ── HTTP 工具 ────────────────────────────────────────────────────────────
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readJsonBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, "PAYLOAD_TOO_LARGE", "请求体过大。"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError(400, "INVALID_JSON", "请求体不是有效的 JSON。"));
      }
    });
    request.on("error", (error) => reject(error));
  });
}

function sanitizeSingleLine(value, maxLength) {
  const text = String(value ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return [...text].slice(0, maxLength).join("");
}

function shortMessage(error) {
  return String(error?.message || error || "未知错误").slice(0, 300);
}

function isLockBusyError(error) {
  return String(error?.code || "").toUpperCase() === "LOCK_BUSY"
    || /LOCK_BUSY|Another 1688 command is running/i.test(String(error?.message || ""));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 请求处理 ─────────────────────────────────────────────────────────────
function healthPayload() {
  return {
    ok: true,
    product: PRODUCT,
    version: VERSION,
    loginBrokerProtocol: LOGIN_BROKER_PROTOCOL,
    integrationProtocol: INTEGRATION_PROTOCOL,
    capabilities: {
      imageCandidateLimit: IMAGE_CANDIDATE_LIMIT,
      supplierStrengthRefresh: true,
      automaticSupplierStrength: true,
      automaticSupplierStrengthEnabled: true,
      imageSearchRiskRecovery: true,
      excelBatchImport: true,
      imageSearchWithoutPrice: true,
      persistentSearchRateLimit: true,
      manualRiskResume: true,
    },
    auth: publicAuth(),
    queue: queueSummary(),
    service: {
      pid: process.pid,
      startedAt: startedAtIso,
      sessionRoot: BB1688_HOME,
      projectRoot: PROJECT_ROOT,
    },
  };
}

async function handleCreateTask(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(422, "PROCUREMENT_INPUT_INVALID", "任务创建请求必须是对象。");
  }
  const allowed = new Set(["imageBase64", "title", "fileName", "mimeType"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError(422, "PROCUREMENT_INPUT_INVALID", `不支持的字段：${key}`);
  }
  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
  if (!imageBase64) throw new ApiError(422, "PROCUREMENT_INPUT_INVALID", "缺少图片数据（imageBase64）。");
  const image = Buffer.from(imageBase64, "base64");
  if (image.length < 64) throw new ApiError(422, "IMAGE_INVALID", "图片数据无效。");
  if (image.length > MAX_IMAGE_BYTES) throw new ApiError(413, "IMAGE_TOO_LARGE", "图片超过 12MB 上限。");
  const detected = detectProcurementImageType(image);
  if (!detected) throw new ApiError(422, "IMAGE_TYPE_INVALID", "仅支持 PNG / JPEG / WEBP / GIF / BMP 商品图。");

  const taskId = crypto.randomUUID();
  await fsp.mkdir(TASK_IMAGE_DIR, { recursive: true });
  const imageFile = path.join(TASK_IMAGE_DIR, `${taskId}.${detected.extension}`);
  await fsp.writeFile(imageFile, image);

  const task = {
    id: taskId,
    title: sanitizeSingleLine(body.title, 200) || "Amazon product",
    fileName: sanitizeSingleLine(body.fileName, 160) || `amazon-product.${detected.extension}`,
    mimeType: detected.mimeType,
    imageFile,
    imageSha256: crypto.createHash("sha256").update(image).digest("hex"),
    status: "pending_review",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    queueSequence: 0,
    confirmedAt: null,
    search: null,
    imageId: null,
    candidates: [],
    failure: null,
  };
  tasks.set(taskId, task);
  await persistTask(task);
  log(`任务 ${taskId} 已创建（${task.fileName}，${image.length} bytes）`);
  return { ok: true, task: publicTask(task) };
}

async function handleConfirmTask(taskId, body) {
  const task = tasks.get(taskId);
  if (!task) throw new ApiError(404, "PROCUREMENT_TASK_NOT_FOUND", "未找到对应的 1688 找厂任务。");
  if (!body || body.confirmed !== true) {
    throw new ApiError(422, "PROCUREMENT_INPUT_INVALID", "确认参数无效（confirmed 必须为 true）。");
  }
  // Image matching needs an image and quantity; an unknown Amazon sale price
  // remains null so that later cost/profit calculations cannot invent a price.
  const sellingPrice = body.sellingPrice === null || body.sellingPrice === undefined || body.sellingPrice === ""
    ? null
    : Number(body.sellingPrice);
  if (sellingPrice !== null && (!Number.isFinite(sellingPrice) || sellingPrice <= 0)) {
    throw new ApiError(422, "PROCUREMENT_INPUT_INVALID", "sellingPrice 必须为空或大于 0。");
  }
  const currency = String(body.sellingPriceCurrency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError(422, "PROCUREMENT_INPUT_INVALID", "售价币种无效。");
  const targetQuantity = Math.trunc(Number(body.targetQuantity));
  if (!Number.isInteger(targetQuantity) || targetQuantity < 1 || targetQuantity > 1_000_000) {
    throw new ApiError(422, "PROCUREMENT_INPUT_INVALID", "targetQuantity 必须是 1 到 1000000 的整数。");
  }
  if (["review_candidates", "queued", "running", "risk_blocked"].includes(task.status)) {
    return { ok: true, task: publicTask(task) };
  }
  if (!["pending_review", "failed", "risk_blocked", "queued", "running"].includes(task.status)) {
    throw new ApiError(409, "PROCUREMENT_TASK_STATE_INVALID", `任务状态不允许确认：${task.status}`);
  }
  task.search = {
    sellingPrice,
    sellingPriceCurrency: currency,
    targetQuantity,
    destination: sanitizeSingleLine(body.destination, 80) || "Amazon 商品成本估算",
  };
  task.confirmedAt = new Date().toISOString();
  task.status = "queued";
  task.failure = null;
  task.candidates = [];
  queueSequence += 1;
  task.queueSequence = queueSequence;
  await persistTask(task);
  enqueueTask(task.id);
  log(`任务 ${taskId} 已确认并排队（moq=${targetQuantity}，${sellingPrice === null ? "售价待补充" : `${currency} ${sellingPrice}`}）`);
  return { ok: true, task: publicTask(task) };
}

function runtimePayload() {
  return { ok: true, product: PRODUCT, version: VERSION, auth: publicAuth(), queue: queueSummary(),
    service: { pid: process.pid, startedAt: startedAtIso } };
}

async function preserveInterruptedSearchPause() {
  if (searchPolicy.view().manualResumeRequired) return;
  const interrupted = [...tasks.values()].find(task => task.failure?.code === "SEARCH_INTERRUPTED");
  if (interrupted) await searchPolicy.pauseForManual("SEARCH_INTERRUPTED", interrupted.id);
}

async function handleStartRateTrial(body) {
  const allowed = new Set(["confirmed", "startPerHour", "stepPerHour", "stageDurationMs"]);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => !allowed.has(key)) || body.confirmed !== true
    || body.startPerHour !== 90 || body.stepPerHour !== 10 || body.stageDurationMs !== 3_600_000) {
    throw new ApiError(422, "RATE_TRIAL_INPUT_INVALID", "请确认每小时90个起步、每档一小时、逐档增加10个的测试参数。");
  }
  if (runningTaskId || workerPumping || hasActiveSearchProcess() || loginChildAlive() || loginLaunchPending) {
    throw new ApiError(409, "RATE_TRIAL_BUSY", "当前搜图或人工验证尚未结束，请稍后启用速率测试。");
  }
  try {
    await searchPolicy.startTrial({ startPerHour: 90, stepPerHour: 10, stageDurationMs: 3_600_000 });
  } catch (error) {
    if (["RATE_POLICY_NOT_READY", "RATE_TRIAL_EXISTS", "INVALID_RATE_TRIAL"].includes(error?.code)) {
      throw new ApiError(error.status, error.code, error.message);
    }
    throw error;
  }
  cancelQueueWake();
  void pumpQueue();
  return runtimePayload();
}

async function handleResumeQueue(body) {
  if (body?.confirmed !== true) throw new ApiError(422, "RESUME_CONFIRMATION_REQUIRED", "请明确确认继续搜图（confirmed 必须为 true）。");
  if (hasActiveSearchProcess()) throw new ApiError(409, "SEARCH_WORKER_STOP_FAILED", "搜图工作进程尚未确认退出，请先检查服务。");
  if (loginChildAlive() || loginLaunchPending) throw new ApiError(409, "VERIFICATION_IN_PROGRESS", "请等待人工验证窗口完成后再继续搜图。");
  const beforeResume = searchPolicy.view();
  if (!await searchPolicy.resume({ confirmed: true })) {
    throw new ApiError(409, "MANUAL_VERIFICATION_REQUIRED", "请先在专用 Edge 完成本次人工验证，再点击继续搜图。", { ratePolicy: searchPolicy.view() });
  }
  for (const task of [...tasks.values()].sort((a, b) => Number(a.queueSequence || 0) - Number(b.queueSequence || 0))) {
    const interruptedTask = isSearchExecutionPause(beforeResume.pausedReason)
      && task.id === beforeResume.blockedTaskId && task.status === "failed"
      && task.failure?.code === beforeResume.pausedReason;
    if (!interruptedTask && task.status !== "risk_blocked" && !(task.status === "failed" && task.failure?.code === "AUTH_REQUIRED")) continue;
    task.status = "queued";
    task.failure = null;
    await persistTask(task);
    if (!taskQueue.includes(task.id)) taskQueue.push(task.id);
  }
  cancelQueueWake();
  void pumpQueue();
  return runtimePayload();
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (pathname === "/api/v1/health" && request.method === "GET") {
    sendJson(response, 200, healthPayload());
    return;
  }
  if (pathname === "/api/v1/runtime" && request.method === "GET") {
    const verify = url.searchParams.get("verify") === "1";
    if (verify && !searchPolicy.view().manualResumeRequired && searchPolicy.waitMs() === 0) await runBrowserOp(() => verifyNow({ force: false }));
    sendJson(response, 200, runtimePayload());
    return;
  }
  if (pathname === "/api/v1/queue/rate-trial" && request.method === "GET") {
    sendJson(response, 200, { ok: true, ratePolicy: searchPolicy.view() });
    return;
  }
  if (pathname === "/api/v1/queue/rate-trial" && request.method === "POST") {
    sendJson(response, 200, await handleStartRateTrial(await readJsonBody(request, 64 * 1024)));
    return;
  }
  if (pathname === "/api/v1/queue/resume" && request.method === "POST") {
    sendJson(response, 200, await handleResumeQueue(await readJsonBody(request, 64 * 1024)));
    return;
  }
  if (pathname === "/api/v1/auth/open-login" && request.method === "POST") {
    const body = await readJsonBody(request, 64 * 1024);
    const purpose = body?.purpose === "image_search" ? "image_search" : body?.purpose === "login" ? "login" : null;
    if (!purpose) throw new ApiError(422, "LOGIN_PURPOSE_INVALID", "1688 登录窗口用途必须是 login 或 image_search。");
    let taskId = null;
    if (purpose === "image_search") {
      taskId = String(body?.taskId || "");
      if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new ApiError(422, "LOGIN_TASK_NOT_ALLOWED", "图片搜索验证必须携带有效任务编号。");
    } else if (body?.taskId) {
      throw new ApiError(422, "LOGIN_TASK_NOT_ALLOWED", "普通 1688 登录不能携带图片搜索任务。");
    }
    const data = await openLogin({ restart: body?.restart === true, purpose, taskId });
    sendJson(response, 202, data);
    return;
  }
  if (pathname === "/api/v1/tasks" && request.method === "GET") {
    const list = [...tasks.values()]
      .sort((left, right) => Number(left.queueSequence || 0) - Number(right.queueSequence || 0))
      .map(publicTask);
    sendJson(response, 200, { ok: true, tasks: list });
    return;
  }
  if (pathname === "/api/v1/tasks" && request.method === "POST") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await handleCreateTask(body));
    return;
  }
  const taskMatch = /^\/api\/v1\/tasks\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (taskMatch && request.method === "GET") {
    const task = tasks.get(taskMatch[1]);
    if (!task) throw new ApiError(404, "PROCUREMENT_TASK_NOT_FOUND", "未找到对应的 1688 找厂任务。");
    sendJson(response, 200, { ok: true, task: publicTask(task) });
    return;
  }
  const confirmMatch = /^\/api\/v1\/tasks\/([A-Za-z0-9_-]+)\/confirm$/.exec(pathname);
  if (confirmMatch && request.method === "POST") {
    const body = await readJsonBody(request, 64 * 1024);
    sendJson(response, 200, await handleConfirmTask(confirmMatch[1], body));
    return;
  }
  if (pathname === "/" && request.method === "GET") {
    sendJson(response, 200, healthPayload());
    return;
  }
  throw new ApiError(404, "NOT_FOUND", "接口不存在。");
}

// ── 启动 ─────────────────────────────────────────────────────────────────
async function main() {
  for (const dir of [HANDSHAKE_DIR, TASK_IMAGE_DIR, TASKS_DIR, LOG_DIR]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  // 清理上一次运行残留的握手文件
  for (const entry of await fsp.readdir(HANDSHAKE_DIR).catch(() => [])) {
    await fsp.rm(path.join(HANDSHAKE_DIR, entry), { force: true }).catch(() => undefined);
  }
  await loadTasksFromDisk();
  await searchPolicy.initialize([...tasks.values()]);
  await preserveInterruptedSearchPause();
  await loadAuthFromDisk();
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      const status = error instanceof ApiError ? error.status : 500;
      const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
      const message = error instanceof ApiError ? error.message : "1688 采购助手内部错误。";
      if (!(error instanceof ApiError)) log(`内部错误：${error?.stack || error}`);
      if (!response.headersSent) {
        sendJson(response, status, { ok: false, error: { code, message, details: error?.details ?? null } });
      } else {
        response.end();
      }
    });
  });
  server.on("error", (error) => {
    log(`服务监听失败（端口 ${PORT}）：${shortMessage(error)}`);
    process.exitCode = 1;
    server.close();
  });
  server.listen(PORT, HOST, () => {
    queueReady = true;
    void pumpQueue();
    log(`1688 采购助手桥接服务已就绪：http://${HOST}:${PORT}（会话目录：${BB1688_HOME}）`);
  });
}

main().catch((error) => {
  log(`服务启动失败：${error?.stack || error}`);
  process.exitCode = 1;
});
