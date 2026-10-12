import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const PROGRAM_MONITOR_INTERVALS = Object.freeze({ amazonMs: 15 * 60_000, supplier1688Ms: 30 * 60_000 });
const SOURCES = ['amazon', 'supplier1688'];
const ACTIVE = new Set(['queued', 'running', 'cooldown']);
const LOGIN = /^(?:LOGIN_REQUIRED|NOT_LOGGED_IN|AUTH_REQUIRED|SESSION_EXPIRED)$/;
const RISK = /RISK|CAPTCHA|VERIFICATION|CHALLENGE|SLIDER/;
const copy = value => structuredClone(value);
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const stamp = value => typeof value === 'number' ? value : Date.parse(value);
const safeCode = value => /^[A-Z0-9_]{1,80}$/.test(String(value || '')) ? String(value) : 'MONITOR_READ_FAILED';
const identity = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
function unwrap(value) {
  if (value?.ok === false) throw Object.assign(new Error('Monitor source unavailable'), { code: value.error?.code || value.code });
  return value && Object.hasOwn(value, 'data') ? value.data : value;
}
function initialCheck() {
  return { lastCheckedAt: null, status: 'idle', runId: null, observedStatus: null, hasActivity: false,
    consecutiveFailures: 0, failureIncident: 0, reportedFailure: null, lastEventFingerprint: null, errorCode: null };
}
function coverage(quality) {
  return Object.fromEntries(['price', 'weight'].map(field => [field, {
    verified: count(quality?.[field]?.verified), unavailable: count(quality?.[field]?.unavailable),
    invalid: count(quality?.[field]?.invalid), pending: count(quality?.[field]?.missing),
  }]));
}
function coverageText(value) {
  return [['price', '价格'], ['weight', '重量']].map(([field, label]) => {
    const item = value[field];
    return `${label}：已核验 ${item.verified}、页面未提供 ${item.unavailable}、异常 ${item.invalid}、待采集 ${item.pending}`;
  }).join('；');
}
function trialMetrics(trigger) {
  return { targetPerHour: count(trigger.targetPerHour), started: count(trigger.started),
    succeeded: count(trigger.succeeded), elapsedMinutes: count(trigger.elapsedMs) / 60_000,
    actualPerHour: count(trigger.actualPerHour), previousPassedPerHour: trigger.previousPassedPerHour == null
      ? null : count(trigger.previousPassedPerHour), reason: safeCode(trigger.reason) };
}

// Observes summaries only. Loaders must never authorize providers, request health,
// resume tasks or create work. Business retry and pacing remain with their runners.
export class ProgramMonitor {
  constructor({ statePath, loadAmazon, loadSupplier1688, now = Date.now,
    intervals = {}, checkTimeoutMs = 10_000, maxEvents = 100, onError = () => {},
    setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    if (!statePath || typeof loadAmazon !== 'function' || typeof loadSupplier1688 !== 'function') {
      throw new TypeError('ProgramMonitor requires statePath and read-only loaders');
    }
    this.statePath = statePath;
    this.loaders = { amazon: loadAmazon, supplier1688: loadSupplier1688 };
    this.now = now;
    this.intervals = { ...PROGRAM_MONITOR_INTERVALS, ...intervals };
    if (Object.values(this.intervals).some(value => !Number.isFinite(value) || value <= 0)) throw new TypeError('Invalid monitor intervals');
    this.checkTimeoutMs = Math.max(1, Number(checkTimeoutMs) || 10_000);
    this.maxEvents = Math.max(1, Math.min(100, Number(maxEvents) || 100));
    this.onError = onError;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.state = { version: 1, checks: Object.fromEntries(SOURCES.map(source => [source, initialCheck()])), events: [], notifiedFingerprints: [] };
    this.running = false;
    this.timers = new Map();
    this.work = new Map();
    this.controllers = new Map();
    this.writeQueue = Promise.resolve();
    this.starting = null;
    this.persistenceError = null;
  }

  start({ timer = true } = {}) {
    if (this.starting) return this.starting;
    if (this.running) return Promise.resolve(this.snapshot());
    this.running = true;
    this.starting = this.initialize(timer).finally(() => { this.starting = null; });
    return this.starting;
  }

  async initialize(timer) {
    try {
      let saved;
      try { saved = JSON.parse(await fs.readFile(this.statePath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (saved) {
        if (saved.version !== 1 || !saved.checks || !SOURCES.every(source => saved.checks[source])
          || !Array.isArray(saved.events) || !Array.isArray(saved.notifiedFingerprints)) {
          throw Object.assign(new Error('Invalid program monitor state'), { code: 'PROGRAM_MONITOR_STATE_INVALID' });
        }
        this.state = { ...saved, events: saved.events.slice(-this.maxEvents), notifiedFingerprints: saved.notifiedFingerprints.slice(-1000) };
      }
      if (!this.running) return this.snapshot();
      if (timer) {
        for (const source of SOURCES) {
          const handle = this.setIntervalFn(() => { void this.check(source).catch(error => this.report(error)); }, this.intervals[`${source}Ms`]);
          handle?.unref?.();
          this.timers.set(source, handle);
        }
      }
      await Promise.all(SOURCES.map(source => this.check(source)));
      return this.snapshot();
    } catch (error) {
      this.running = false;
      this.clearTimers();
      throw error;
    }
  }

  snapshot() {
    return copy({ enabled: this.running, intervals: this.intervals, checks: this.state.checks,
      events: this.state.events, persistenceError: this.persistenceError });
  }

  // Single flight per source: a slow loader cannot stack repeated observations.
  check(source) {
    if (!SOURCES.includes(source)) return Promise.reject(new TypeError('Unknown monitor source'));
    if (!this.running) return Promise.resolve(this.snapshot());
    if (this.work.has(source)) return this.work.get(source);
    const work = this.observe(source).finally(() => { this.work.delete(source); });
    this.work.set(source, work);
    return work;
  }

  async observe(source) {
    const controller = new AbortController();
    this.controllers.set(source, controller);
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error('Monitor read timed out'), { code: 'MONITOR_READ_TIMEOUT' })), this.checkTimeoutMs);
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => this.loaders[source]({ signal: controller.signal })), aborted]);
      if (!this.running) return;
      const previousCheckedAt = this.state.checks[source].lastCheckedAt;
      this.state.checks[source].lastCheckedAt = new Date(this.now()).toISOString();
      if (source === 'amazon') this.observeAmazon(unwrap(value), previousCheckedAt);
      else this.observeSupplier(unwrap(value));
    } catch (error) {
      if (!this.running) return;
      this.observeFailure(source, safeCode(error?.code));
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abortListener);
      this.controllers.delete(source);
    }
    if (this.running) await this.persist();
    return this.snapshot();
  }

  healthy(check, status) {
    check.consecutiveFailures = 0;
    check.errorCode = null;
    check.status = status;
  }

  observeFailure(source, code) {
    const check = this.state.checks[source];
    check.lastCheckedAt = new Date(this.now()).toISOString();
    if (check.consecutiveFailures === 0) check.failureIncident += 1;
    check.consecutiveFailures += 1;
    check.errorCode = code;
    check.status = check.hasActivity ? 'degraded' : 'unavailable';
    if (check.hasActivity && check.consecutiveFailures >= 3) {
      const details = { runId: check.runId, code, consecutiveFailures: check.consecutiveFailures };
      if (source === 'amazon') details.coverage = check.coverage || coverage();
      this.event(source, 'persistent_failure', [check.runId, check.trialCreatedAt, check.failureIncident],
        `${source === 'amazon' ? 'Amazon 采集' : '1688 试验'}连续 ${check.consecutiveFailures} 次检查失败（${code}），任务断点保留，请检查服务。`
          + (details.coverage ? ` ${coverageText(details.coverage)}。` : ''), details);
      check.reportedFailure = { runId: check.runId, trialCreatedAt: check.trialCreatedAt ?? null,
        incident: check.failureIncident, code };
    }
  }

  recovered(source, runId, eligible) {
    const check = this.state.checks[source];
    const failure = check.reportedFailure;
    if (!failure) return;
    if (!runId || failure.runId !== runId) { check.reportedFailure = null; return; }
    if (!eligible) return;
    const details = { runId, previousCode: failure.code, failureIncident: failure.incident };
    if (source === 'amazon') details.coverage = check.coverage || coverage();
    else details.trialCreatedAt = check.trialCreatedAt ?? null;
    this.event(source, 'recovered', [runId, failure.trialCreatedAt, failure.incident],
      `${source === 'amazon' ? 'Amazon 采集' : '1688 匹配'}故障已恢复，已确认同一任务状态正常，原任务断点保留。`
        + (details.coverage ? ` ${coverageText(details.coverage)}。` : ''), details);
    check.reportedFailure = null;
  }

  observeAmazon(value, previousCheckedAt) {
    const job = value?.job || value;
    const check = this.state.checks.amazon;
    if (!job || job.archivedAt || job.status === 'cancelled') {
      this.healthy(check, 'idle');
      Object.assign(check, { runId: null, observedStatus: null, hasActivity: false, reportedFailure: null });
      return;
    }
    const runId = job.runId || job.id;
    const previousRunId = check.runId;
    const previousStatus = check.observedStatus;
    const previouslyActive = check.hasActivity && previousRunId === runId;
    if (previousRunId !== runId) { check.hasActivity = false; check.consecutiveFailures = 0; check.reportedFailure = null; }
    check.runId = runId;
    check.coverage = coverage(job.quality);
    check.counts = Object.fromEntries(['total', 'processed', 'pending', 'complete', 'partial', 'failed'].map(key => [key, count(job.counts?.[key])]));
    check.hasActivity = ACTIVE.has(job.status) || job.status === 'needs_attention';
    if (job.status === 'failed' || job.status === 'error') {
      check.hasActivity = true;
      this.observeFailure('amazon', safeCode(job.causeCode));
    } else {
      this.healthy(check, job.status || 'idle');
    }
    if (job.status === 'paused') check.reportedFailure = null;
    this.recovered('amazon', runId, ACTIVE.has(job.status) || job.status === 'completed');
    if (job.status === 'needs_attention') {
      const reason = safeCode(job.causeCode);
      this.event('amazon', 'needs_attention', [runId, reason],
        `Amazon 采集需要人工处理（${reason}），任务断点已保留。${coverageText(check.coverage)}。`,
        { runId, reason, coverage: check.coverage, counts: check.counts });
    }
    // Collector exposes createdAt and completedAt. Both are needed to prove
    // that an unseen short batch was created and finished since the last poll.
    const createdAt = stamp(job.createdAt);
    const completedAt = stamp(job.completedAt);
    const completedBetweenChecks = previousRunId !== runId && Number.isFinite(stamp(previousCheckedAt))
      && createdAt >= stamp(previousCheckedAt) && completedAt >= createdAt && completedAt <= this.now();
    if (job.status === 'completed' && ((previouslyActive && previousStatus !== 'completed') || completedBetweenChecks)) {
      this.event('amazon', 'completed', [runId], `Amazon 采集已完成。${coverageText(check.coverage)}。`,
        { runId, coverage: check.coverage, counts: check.counts });
    }
    check.observedStatus = job.status || null;
  }

  observeSupplier(value) {
    const check = this.state.checks.supplier1688;
    const runtime = unwrap(value?.runtime) || {};
    const pipeline = unwrap(value?.pipeline);
    const policy = unwrap(value?.ratePolicy) || runtime.queue?.ratePolicy || {};
    const trial = unwrap(value?.rateTrial) || policy.rateTrial || null;
    const pipelineActive = ACTIVE.has(pipeline?.status) || pipeline?.status === 'needs_attention';
    const pipelineRunId = pipeline?.runId || null;
    const previousPipelineRunId = check.observedPipelineRunId ?? check.runId;
    if (pipelineRunId && pipelineRunId !== previousPipelineRunId) {
      // Failure streaks belong to one batch; a replacement must earn its own
      // three failed observations and cannot inherit another batch's recovery.
      check.consecutiveFailures = 0;
      check.reportedFailure = null;
      check.hasActivity = false;
    }
    check.observedPipelineRunId = pipelineRunId;
    if (pipelineActive) {
      if (!check.hasActivity) check.consecutiveFailures = 0;
      check.hasActivity = true;
    }
    if (value?.available === false) {
      if (pipeline?.status === 'paused' || pipeline?.status === 'cancelled' || pipeline?.archivedAt) {
        check.hasActivity = false; check.reportedFailure = null;
        this.healthy(check, pipeline.status === 'paused' ? 'paused' : 'idle'); return;
      }
      if (pipeline?.status === 'complete') check.hasActivity = false;
      if (pipeline?.runId) check.runId = pipeline.runId;
      if (check.frozenTrialCreatedAt && !pipelineActive) { this.healthy(check, 'stopped'); return; }
      this.observeFailure('supplier1688', safeCode(value.errorCode || value.code));
      return;
    }
    if (!trial) {
      check.hasActivity = pipelineActive;
      this.healthy(check, pipeline?.status || 'idle');
      check.runId = pipeline?.runId || null;
      if (!pipeline || pipeline.status === 'paused' || pipeline.status === 'cancelled' || pipeline.archivedAt) check.reportedFailure = null;
      this.recovered('supplier1688', check.runId, (ACTIVE.has(pipeline?.status) || pipeline?.status === 'complete') && runtime.auth?.ready !== false);
      if (pipelineActive && runtime.auth?.ready === false) {
        this.event('supplier1688', 'login_required', [null, check.runId],
          '1688 匹配需要登录，任务断点保留；请在程序中完成登录后明确恢复。',
          { trialCreatedAt: null, runId: check.runId, reason: 'LOGIN_REQUIRED' });
        check.status = 'needs_attention';
      }
      return;
    }
    if (check.trialCreatedAt !== trial.createdAt) {
      Object.assign(check, { trialCreatedAt: trial.createdAt, runId: null, frozenTrialCreatedAt: null,
        observedStatus: null, hasActivity: pipelineActive, trialHasSearches: false });
    }
    if (check.frozenTrialCreatedAt === trial.createdAt) {
      check.hasActivity = false;
      check.reportedFailure = null;
      this.healthy(check, 'stopped');
      return;
    }
    const stages = [trial.currentStage, ...(trial.history || [])].filter(Boolean);
    const hasSearches = stages.some(stage => count(stage.started) > 0);
    check.trialHasSearches ||= hasSearches;
    check.hasActivity ||= hasSearches;
    check.targetPerHour = count(trial.targetPerHour);
    // A new batch can finish between polls. Timestamp ownership plus actual
    // searches lets us recognize it without counting an old completed batch.
    if (hasSearches && (pipelineActive || pipeline?.status === 'complete') && !pipeline?.archivedAt && pipeline?.runId
      && stamp(pipeline.startedAt || pipeline.createdAt) >= stamp(trial.createdAt)) check.runId = pipeline.runId;
    if (trial.runId && hasSearches) check.runId = trial.runId;
    this.healthy(check, trial.status || 'waiting');
    const trigger = trial.trigger;
    const reason = String(trigger?.reason || pipeline?.causeCode || policy.pausedReason || '').toUpperCase();
    const manuallyPaused = pipeline?.status === 'paused' || (trial.status === 'stopped_manual' && !LOGIN.test(reason));
    if (trigger && (trial.status === 'stopped_risk' || RISK.test(reason))) {
      const metrics = trialMetrics(trigger);
      const passed = metrics.previousPassedPerHour == null ? '尚无完整通过的档位' : `上一完整通过档位 ${metrics.previousPassedPerHour} 次/小时`;
      this.event('supplier1688', 'verification_required', [trial.createdAt, trigger.at],
        `1688 试验因滑块或访问验证停止：目标 ${metrics.targetPerHour} 次/小时，实际发起 ${metrics.started} 次（含重试），成功返回候选 ${metrics.succeeded} 次，触发前 ${metrics.elapsedMinutes.toFixed(2)} 分钟，折算实际速率 ${metrics.actualPerHour.toFixed(2)} 次/小时；${passed}。本次观察不能认定固定验证阈值，断点保留，请人工处理。`,
        { trialCreatedAt: trial.createdAt, runId: check.runId, ...metrics });
      Object.assign(check, { status: 'stopped', frozenTrialCreatedAt: trial.createdAt, hasActivity: false, reportedFailure: null });
      return;
    }
    if (manuallyPaused) { check.status = 'paused'; check.hasActivity = false; check.reportedFailure = null; return; }
    const needsLogin = (LOGIN.test(reason) && (hasSearches || pipelineActive || trigger))
      || ((hasSearches || pipelineActive) && runtime.auth?.ready === false);
    if (needsLogin) {
      this.event('supplier1688', 'login_required', [trial.createdAt, check.runId],
        '1688 匹配需要登录，任务断点保留；请在程序中完成登录后明确恢复。',
        { trialCreatedAt: trial.createdAt, runId: check.runId, reason: LOGIN.test(reason) ? reason : 'LOGIN_REQUIRED' });
      check.status = 'needs_attention';
    }
    this.recovered('supplier1688', pipeline?.runId, !needsLogin && (ACTIVE.has(pipeline?.status) || pipeline?.status === 'complete'));
    if (trial.status === 'throughput_limited') {
      this.event('supplier1688', 'throughput_limited', [trial.createdAt],
        `1688 目标 ${check.targetPerHour} 次/小时的实际样本不足，该档未验证；试验已停止加速并保持当前速率。`,
        { trialCreatedAt: trial.createdAt, runId: check.runId, targetPerHour: check.targetPerHour });
    }
    if (hasSearches && check.runId && pipeline?.runId === check.runId && pipeline.status === 'complete') {
      this.event('supplier1688', 'completed', [trial.createdAt, check.runId],
        `1688 实际测试批次已完成，目标 ${check.targetPerHour} 次/小时。仅完整通过的小时档位可作为本次观察依据；样本不足或观测中断不能算通过。`,
        { trialCreatedAt: trial.createdAt, runId: check.runId, targetPerHour: check.targetPerHour,
          previousPassedPerHour: trial.lastPassedPerHour ?? null });
      check.status = 'completed';
      check.hasActivity = false;
    }
    check.observedStatus = trial.status || null;
  }

  event(source, kind, key, message, details) {
    const fingerprint = identity(source, kind, key);
    if (this.state.notifiedFingerprints.includes(fingerprint)) return;
    this.state.notifiedFingerprints.push(fingerprint);
    this.state.notifiedFingerprints = this.state.notifiedFingerprints.slice(-1000);
    this.state.checks[source].lastEventFingerprint = fingerprint;
    this.state.events.push({ id: fingerprint, kind, source, message, createdAt: new Date(this.now()).toISOString(), details: copy(details) });
    this.state.events = this.state.events.slice(-this.maxEvents);
  }

  persist() {
    const text = JSON.stringify(this.state, null, 2) + '\n';
    const write = async () => {
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.statePath), { recursive: true });
        await fs.writeFile(temporary, text, { mode: 0o600 });
        await fs.rename(temporary, this.statePath);
        this.persistenceError = null;
      } catch (error) {
        this.persistenceError = 'PROGRAM_MONITOR_PERSISTENCE_FAILED';
        throw error;
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    };
    const next = this.writeQueue.then(write, write);
    this.writeQueue = next.catch(() => {});
    return next;
  }

  report(error) { try { this.onError(error); } catch { /* Logging cannot terminate scheduling. */ } }
  clearTimers() { for (const timer of this.timers.values()) this.clearIntervalFn(timer); this.timers.clear(); }
  async stop() {
    this.running = false;
    this.clearTimers();
    for (const controller of this.controllers.values()) controller.abort(new Error('Monitor stopped'));
    await Promise.allSettled([this.starting, ...this.work.values()]);
    await this.writeQueue;
  }
}
