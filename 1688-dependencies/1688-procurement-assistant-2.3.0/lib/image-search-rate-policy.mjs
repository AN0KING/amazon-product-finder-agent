import fs from 'node:fs/promises';
import path from 'node:path';

// Default pacing: 18 seconds plus 20 seconds after every tenth search.
export const SEARCH_MIN_GAP_MS = 18_000;
export const SEARCH_COOLDOWN_EVERY = 10;
export const SEARCH_COOLDOWN_MS = 20_000;
// Platform backoff is independent of the trial's ordinary pacing.
export const SEARCH_RATE_LIMIT_COOLDOWN_MS = 300_000;
const HOUR_MS = 3_600_000;
const TRIAL_STATUSES = new Set(['waiting', 'running', 'throughput_limited', 'stopped_risk', 'stopped_manual']);
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => Number.isFinite(value) && value >= 0 && value < 8.64e15;

function trialOptions({ startPerHour = 90, stepPerHour = 10, stageDurationMs = HOUR_MS } = {}) {
  if (!Number.isSafeInteger(startPerHour) || startPerHour < 1 || startPerHour > HOUR_MS
    || !Number.isSafeInteger(stepPerHour) || stepPerHour < 1 || stepPerHour > HOUR_MS
    || !Number.isSafeInteger(stageDurationMs) || stageDurationMs < 1 || stageDurationMs > 24 * HOUR_MS) {
    throw Object.assign(new Error('Invalid image-search rate trial configuration'), { code: 'INVALID_RATE_TRIAL', status: 422 });
  }
  return { startPerHour, stepPerHour, stageDurationMs };
}

function validStage(stage) {
  return stage && count(stage.sequence) && Number.isSafeInteger(stage.targetPerHour) && stage.targetPerHour > 0
    && ['started', 'succeeded', 'failed'].every(key => count(stage[key]))
    && ['startedAt', 'lastStartedAt'].every(key => timestamp(stage[key]))
    && (stage.endedAt === null || timestamp(stage.endedAt))
    && stage.succeeded + stage.failed <= stage.started;
}

function validateTrial(trial) {
  if (trial == null) return;
  trialOptions(trial);
  if (trial.version !== 1 || !TRIAL_STATUSES.has(trial.status)
    || !Number.isSafeInteger(trial.targetPerHour) || trial.targetPerHour < trial.startPerHour || trial.targetPerHour > HOUR_MS
    || !Array.isArray(trial.history) || trial.history.some(stage => !validStage(stage))
    || (trial.currentStage !== null && !validStage(trial.currentStage))
    || (trial.status === 'running' && !trial.currentStage)
    || !count(trial.stageSequence)
    || (trial.activeSearch && (!timestamp(trial.activeSearch.startedAt) || !count(trial.activeSearch.sequence)))) {
    throw new Error('Invalid rate trial state');
  }
}

export function classifySearchFailure(error = {}) {
  const code = String(error.code || '').toUpperCase();
  const message = String(error.message || '');
  if (/RISK|CAPTCHA|VERIFICATION_REQUIRED|CHALLENGE|SLIDER/.test(code)
    || /验证码|滑块|人工验证|captcha|verify you(?:'|’)re human/i.test(message)) return 'manual';
  if (code === 'RATE_LIMITED' || /(?:^|_)429$/.test(code) || Number(error.status ?? error.statusCode) === 429) return 'rate';
  if (code === 'NOT_LOGGED_IN' || code === 'AUTH_REQUIRED') return 'login';
  return 'other';
}

export class ImageSearchRatePolicy {
  constructor({ file, now = () => Date.now(), minGapMs = SEARCH_MIN_GAP_MS, cooldownMs = SEARCH_COOLDOWN_MS } = {}) {
    this.file = file;
    this.now = now;
    this.minGapMs = Number.isFinite(Number(minGapMs)) ? Math.max(SEARCH_MIN_GAP_MS, Number(minGapMs)) : SEARCH_MIN_GAP_MS;
    this.cooldownMs = Number.isFinite(Number(cooldownMs)) ? Math.max(SEARCH_COOLDOWN_MS, Number(cooldownMs)) : SEARCH_COOLDOWN_MS;
    this.state = { version: 1, searchCount: 0, lastStartedAt: 0, nextAllowedAt: 0, cooldownUntil: 0,
      manualResumeRequired: false, pausedReason: null, pausedAt: null, blockedTaskId: null, manualVerificationCompletedAt: null,
      rateTrial: null };
    this.writes = Promise.resolve();
    this.loaded = false;
  }

  async initialize(tasks = []) {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !count(saved.searchCount)
        || !['lastStartedAt', 'nextAllowedAt', 'cooldownUntil'].every(key => timestamp(saved[key]))
        || typeof saved.manualResumeRequired !== 'boolean'
        || (saved.manualResumeRequired && (typeof saved.pausedReason !== 'string' || !Number.isFinite(saved.pausedAt)))) throw new Error('Invalid rate policy state');
      validateTrial(saved.rateTrial);
      this.state = { ...this.state, ...saved };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.state.manualResumeRequired = true;
        this.state.pausedReason = 'RATE_STATE_UNREADABLE';
        this.state.pausedAt = this.now();
      }
    }
    // A restart is an observation gap, even if its saved task can be reused.
    // Keep the rate and history, but never count offline time as a passed hour.
    this.interruptTrial('service_restart');
    if (this.state.rateTrial) this.state.rateTrial.activeSearch = null;
    const blocked = tasks.find(task => task.status === 'risk_blocked');
    if (blocked && (!this.state.manualResumeRequired || this.state.pausedReason !== 'RISK_VERIFICATION_REQUIRED')) this.applyManualPause('RISK_VERIFICATION_REQUIRED', blocked.id);
    const latestTask = tasks.reduce((latest, task) => ['running', 'queued', 'review_candidates', 'risk_blocked', 'failed'].includes(task.status)
      ? Math.max(latest, Date.parse(task.searchStartedAt || task.updatedAt || '') || 0) : latest, 0);
    this.state.lastStartedAt = Math.max(this.state.lastStartedAt, latestTask);
    if (this.state.lastStartedAt) this.state.nextAllowedAt = Math.max(this.state.nextAllowedAt, this.state.lastStartedAt + this.effectiveGapMs());
    await this.persist();
    this.loaded = true;
  }

  view() {
    const next = Math.max(this.state.nextAllowedAt, this.state.cooldownUntil);
    const cooling = this.state.cooldownUntil > this.now();
    return {
      minGapMs: this.effectiveGapMs(), maxConcurrent: 1,
      cooldownEvery: this.state.rateTrial ? 0 : SEARCH_COOLDOWN_EVERY,
      cooldownMs: this.state.rateTrial ? 0 : this.cooldownMs,
      nextAllowedAt: next ? new Date(next).toISOString() : null,
      pausedReason: this.state.manualResumeRequired ? this.state.pausedReason : cooling ? 'RATE_LIMITED' : null,
      manualResumeRequired: this.state.manualResumeRequired,
      manualVerificationCompletedAt: this.state.manualVerificationCompletedAt,
      blockedTaskId: this.state.blockedTaskId,
      rateTrial: this.trialView(),
    };
  }

  effectiveGapMs() { return this.state.rateTrial ? Math.ceil(HOUR_MS / this.state.rateTrial.targetPerHour) : this.minGapMs; }

  stageView(stage, at = this.now()) {
    if (!stage) return null;
    const elapsedMs = Math.max(0, (stage.endedAt ?? at) - stage.startedAt);
    return { ...structuredClone(stage), elapsedMs,
      pending: stage.started - stage.succeeded - stage.failed,
      actualPerHour: elapsedMs ? stage.started * HOUR_MS / elapsedMs : 0,
      successPerHour: elapsedMs ? stage.succeeded * HOUR_MS / elapsedMs : 0 };
  }

  trialView() {
    const trial = this.state.rateTrial;
    if (!trial) return null;
    const currentStage = this.stageView(trial.currentStage);
    return { ...structuredClone(trial), currentStage,
      history: trial.history.map(stage => this.stageView(stage)),
      actualPerHour: currentStage?.actualPerHour ?? 0,
      successPerHour: currentStage?.successPerHour ?? 0,
      gapMs: this.effectiveGapMs() };
  }

  async startTrial(options = {}) {
    const configured = trialOptions(options);
    return this.mutate(async () => {
      if (!this.loaded) throw Object.assign(new Error('Rate policy is not ready'), { code: 'RATE_POLICY_NOT_READY', status: 503 });
      if (this.state.rateTrial) {
        if (Object.keys(configured).some(key => this.state.rateTrial[key] !== configured[key])) {
          throw Object.assign(new Error('An existing rate trial must not be replaced'), { code: 'RATE_TRIAL_EXISTS', status: 409 });
        }
        return this.trialView();
      }
      const previous = structuredClone(this.state);
      this.state.rateTrial = { version: 1, ...configured, targetPerHour: configured.startPerHour,
        status: 'waiting', createdAt: this.now(), stageSequence: 0, currentStage: null, history: [],
        lastPassedPerHour: null, trigger: null, activeSearch: null };
      if (this.state.manualResumeRequired) this.applyManualPause(this.state.pausedReason, this.state.blockedTaskId);
      // Configuring the trial cannot shorten an existing reservation or 429.
      if (this.state.lastStartedAt) this.state.nextAllowedAt = Math.max(this.state.nextAllowedAt, this.state.lastStartedAt + this.effectiveGapMs());
      try { await this.persist(); }
      catch (error) { this.state = previous; throw error; }
      return this.trialView();
    });
  }

  interruptTrial(reason) {
    const trial = this.state.rateTrial;
    if (!trial || !['waiting', 'running'].includes(trial.status)) return;
    if (trial.currentStage) {
      trial.currentStage.endedAt = this.now();
      trial.currentStage.outcome = 'interrupted';
      trial.currentStage.reason = reason;
      trial.history.push(trial.currentStage);
      trial.currentStage = null;
    }
    trial.status = 'waiting';
  }

  prepareTrialSearch() {
    const trial = this.state.rateTrial;
    if (!trial || !['waiting', 'running'].includes(trial.status)) return;
    const stage = trial.currentStage;
    if (stage && this.now() - stage.lastStartedAt > Math.max(2 * this.effectiveGapMs(), 60_000)) {
      this.interruptTrial('observation_gap');
    } else if (stage && this.now() - stage.startedAt >= trial.stageDurationMs) {
      const required = Math.ceil(stage.targetPerHour * trial.stageDurationMs / HOUR_MS);
      stage.endedAt = this.now();
      if (stage.started >= required && stage.succeeded + stage.failed === stage.started) {
        stage.outcome = 'passed';
        trial.lastPassedPerHour = trial.targetPerHour;
        trial.history.push(stage);
        trial.currentStage = null;
        const nextRate = trial.targetPerHour + trial.stepPerHour;
        if (nextRate <= HOUR_MS) trial.targetPerHour = nextRate;
        else trial.status = 'throughput_limited';
      } else {
        stage.outcome = 'throughput_limited';
        stage.reason = 'insufficient_observed_searches';
        trial.history.push(structuredClone(stage));
        stage.endedAt = null; // Keep measuring this fixed rate without claiming another passed hour.
        trial.status = 'throughput_limited';
      }
    }
    if (!trial.currentStage && trial.status !== 'throughput_limited') {
      trial.currentStage = { sequence: ++trial.stageSequence, targetPerHour: trial.targetPerHour,
        startedAt: this.now(), lastStartedAt: this.now(), started: 0, succeeded: 0, failed: 0,
        outcome: 'running', endedAt: null };
      trial.status = 'running';
    }
  }

  waitMs() { return Math.max(0, Math.max(this.state.nextAllowedAt, this.state.cooldownUntil) - this.now()); }

  async beginSearch({ taskId = null } = {}) {
    return this.mutate(async () => {
      if (!this.loaded || this.state.manualResumeRequired || this.waitMs() > 0) return false;
      if (this.state.rateTrial?.activeSearch) return false;
      const previous = structuredClone(this.state);
      this.prepareTrialSearch();
      this.state.searchCount += 1;
      this.state.lastStartedAt = this.now();
      this.state.nextAllowedAt = this.now() + this.effectiveGapMs()
        + (!this.state.rateTrial && this.state.searchCount % SEARCH_COOLDOWN_EVERY === 0 ? this.cooldownMs : 0);
      const trial = this.state.rateTrial;
      if (trial) {
        const stage = trial.currentStage;
        if (['running', 'throughput_limited'].includes(trial.status) && stage) { stage.started += 1; stage.lastStartedAt = this.now(); }
        trial.activeSearch = { taskId, sequence: this.state.searchCount, startedAt: this.now(),
          stageSequence: ['running', 'throughput_limited'].includes(trial.status) ? stage?.sequence : null };
      }
      try { await this.persist(); } // Never dispatch before the reservation survives restart.
      catch (error) { this.state = previous; throw error; }
      return true;
    });
  }

  async finishSearch({ taskId = null, success = false, code = null } = {}) {
    return this.mutate(async () => {
      const trial = this.state.rateTrial;
      const reservation = trial?.activeSearch;
      if (!reservation || reservation.taskId !== taskId) return false;
      const previous = structuredClone(this.state);
      const stage = trial.currentStage?.sequence === reservation.stageSequence ? trial.currentStage
        : trial.history.find(item => item.sequence === reservation.stageSequence);
      if (stage) {
        stage[success ? 'succeeded' : 'failed'] += 1;
        stage.lastResultAt = this.now();
        stage.lastCode = code;
        if (trial.trigger?.taskId === taskId) {
          trial.trigger.succeeded = stage.succeeded;
          trial.trigger.failed = stage.failed;
          trial.trigger.successPerHour = trial.trigger.elapsedMs ? stage.succeeded * HOUR_MS / trial.trigger.elapsedMs : 0;
        }
      }
      trial.activeSearch = null;
      try { await this.persist(); }
      catch (error) { this.state = previous; throw error; }
      return true;
    });
  }

  async pauseForManual(reason, taskId = null) {
    return this.mutate(async () => { this.applyManualPause(reason, taskId); await this.persist(); });
  }

  applyManualPause(reason, taskId) {
    const trial = this.state.rateTrial;
    if (trial && !['stopped_risk', 'stopped_manual'].includes(trial.status)) {
      const stage = trial.currentStage;
      const isRisk = classifySearchFailure({ code: reason }) === 'manual';
      const measured = this.stageView(stage);
      trial.trigger = { reason, taskId, at: this.now(), targetPerHour: trial.targetPerHour,
        started: measured?.started ?? 0, succeeded: measured?.succeeded ?? 0, failed: measured?.failed ?? 0,
        elapsedMs: measured?.elapsedMs ?? 0, actualPerHour: measured?.actualPerHour ?? 0,
        successPerHour: measured?.successPerHour ?? 0, previousPassedPerHour: trial.lastPassedPerHour };
      if (stage && stage.endedAt === null) {
        stage.endedAt = this.now(); stage.outcome = isRisk ? 'stopped_risk' : 'stopped_manual'; stage.reason = reason;
      }
      trial.status = isRisk ? 'stopped_risk' : 'stopped_manual';
    }
    this.state.manualResumeRequired = true;
    this.state.pausedReason = reason;
    this.state.pausedAt = this.now();
    this.state.blockedTaskId = taskId;
    this.state.manualVerificationCompletedAt = null;
  }

  async markManualVerification({ purpose }) {
    return this.mutate(async () => {
      if (!this.state.manualResumeRequired) return false;
      if (this.state.pausedReason === 'RISK_VERIFICATION_REQUIRED' && purpose !== 'image_search') return false;
      this.state.manualVerificationCompletedAt = new Date(this.now()).toISOString();
      // A verification window can itself search; explicit resume cannot burst.
      this.state.nextAllowedAt = Math.max(this.state.nextAllowedAt, this.now() + this.effectiveGapMs());
      await this.persist();
      return true;
    });
  }

  async resume({ confirmed } = {}) {
    return this.mutate(async () => {
      if (!this.state.manualResumeRequired) return true;
      const verifiedAt = Date.parse(this.state.manualVerificationCompletedAt || '');
      if (confirmed !== true || !Number.isFinite(verifiedAt) || verifiedAt < this.state.pausedAt) return false;
      const pausedState = structuredClone(this.state);
      this.state.manualResumeRequired = false;
      this.state.pausedReason = null;
      this.state.blockedTaskId = null;
      this.state.manualVerificationCompletedAt = null;
      try { await this.persist(); }
      catch (error) { this.state = pausedState; throw error; }
      return true;
    });
  }

  async rateLimit(error = {}) {
    return this.mutate(async () => {
      const raw = error.retryAfter ?? error.details?.retryAfter ?? error.headers?.get?.('retry-after')
        ?? error.headers?.['retry-after'];
      const seconds = typeof raw === 'number' || /^\d+(?:\.\d+)?$/.test(String(raw || '').trim()) ? Number(raw) : NaN;
      const requestedUntil = Number.isFinite(seconds) ? this.now() + Math.max(0, seconds) * 1000 : Date.parse(raw || '');
      this.state.cooldownUntil = Math.max(this.state.cooldownUntil, this.now() + SEARCH_RATE_LIMIT_COOLDOWN_MS, Number.isFinite(requestedUntil) ? requestedUntil : 0);
      this.interruptTrial('RATE_LIMITED');
      await this.persist();
    });
  }

  mutate(operation) {
    const next = this.writes.then(operation, operation);
    this.writes = next.catch(() => {});
    return next;
  }

  async persist() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    await fs.writeFile(temporary, JSON.stringify(this.state, null, 2));
    await fs.rename(temporary, this.file);
  }
}
