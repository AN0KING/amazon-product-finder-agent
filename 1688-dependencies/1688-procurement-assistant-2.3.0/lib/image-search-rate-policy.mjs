import fs from 'node:fs/promises';
import path from 'node:path';

// 用户明确要求搜图节奏为每分钟 3 次（2026-09-28）：18 秒基础间隔 + 每 10 次
// 额外停 20 秒，平均 (10×18s+20s)/10 = 20 秒/次 = 恰好 3 次/分钟。
export const SEARCH_MIN_GAP_MS = 18_000;
export const SEARCH_COOLDOWN_EVERY = 10;
export const SEARCH_COOLDOWN_MS = 20_000;
// A real HTTP 429 from the platform still backs off far longer than the
// routine pacing rest; never shorten this through the pacing knobs.
export const SEARCH_RATE_LIMIT_COOLDOWN_MS = 300_000;

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
      manualResumeRequired: false, pausedReason: null, pausedAt: null, blockedTaskId: null, manualVerificationCompletedAt: null };
    this.writes = Promise.resolve();
    this.loaded = false;
  }

  async initialize(tasks = []) {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !Number.isSafeInteger(saved.searchCount) || saved.searchCount < 0
        || !['lastStartedAt', 'nextAllowedAt', 'cooldownUntil'].every(key => Number.isFinite(saved[key]) && saved[key] >= 0 && saved[key] < 8.64e15)
        || typeof saved.manualResumeRequired !== 'boolean'
        || (saved.manualResumeRequired && (typeof saved.pausedReason !== 'string' || !Number.isFinite(saved.pausedAt)))) throw new Error('Invalid rate policy state');
      this.state = { ...this.state, ...saved };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.state.manualResumeRequired = true;
        this.state.pausedReason = 'RATE_STATE_UNREADABLE';
        this.state.pausedAt = this.now();
      }
    }
    // Existing unresolved challenges must survive the first upgrade too.
    const blocked = tasks.find(task => task.status === 'risk_blocked');
    if (blocked && (!this.state.manualResumeRequired || this.state.pausedReason !== 'RISK_VERIFICATION_REQUIRED')) this.applyManualPause('RISK_VERIFICATION_REQUIRED', blocked.id);
    const latestTask = tasks.reduce((latest, task) => ['running', 'queued', 'review_candidates', 'risk_blocked', 'failed'].includes(task.status)
      ? Math.max(latest, Date.parse(task.searchStartedAt || task.updatedAt || '') || 0) : latest, 0);
    this.state.lastStartedAt = Math.max(this.state.lastStartedAt, latestTask);
    if (this.state.lastStartedAt) this.state.nextAllowedAt = Math.max(this.state.nextAllowedAt, this.state.lastStartedAt + this.minGapMs);
    await this.persist();
    this.loaded = true;
  }

  view() {
    const next = Math.max(this.state.nextAllowedAt, this.state.cooldownUntil);
    const cooling = this.state.cooldownUntil > this.now();
    return {
      minGapMs: this.minGapMs, maxConcurrent: 1, cooldownEvery: SEARCH_COOLDOWN_EVERY, cooldownMs: this.cooldownMs,
      nextAllowedAt: next ? new Date(next).toISOString() : null,
      pausedReason: this.state.manualResumeRequired ? this.state.pausedReason : cooling ? 'RATE_LIMITED' : null,
      manualResumeRequired: this.state.manualResumeRequired,
      manualVerificationCompletedAt: this.state.manualVerificationCompletedAt,
      blockedTaskId: this.state.blockedTaskId,
    };
  }

  waitMs() { return Math.max(0, Math.max(this.state.nextAllowedAt, this.state.cooldownUntil) - this.now()); }

  async beginSearch() {
    return this.mutate(async () => {
      if (!this.loaded || this.state.manualResumeRequired || this.waitMs() > 0) return false;
      this.state.searchCount += 1;
      this.state.lastStartedAt = this.now();
      this.state.nextAllowedAt = this.now() + this.minGapMs
        + (this.state.searchCount % SEARCH_COOLDOWN_EVERY === 0 ? this.cooldownMs : 0);
      await this.persist(); // Never dispatch until the reservation survives restart.
      return true;
    });
  }

  async pauseForManual(reason, taskId = null) {
    return this.mutate(async () => { this.applyManualPause(reason, taskId); await this.persist(); });
  }

  applyManualPause(reason, taskId) {
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
      // A verification window can itself search the image; reserve the next
      // interval so explicit resume cannot immediately fire another search.
      this.state.nextAllowedAt = Math.max(this.state.nextAllowedAt, this.now() + this.minGapMs);
      await this.persist();
      return true;
    });
  }

  async resume({ confirmed } = {}) {
    return this.mutate(async () => {
      if (!this.state.manualResumeRequired) return true;
      const verifiedAt = Date.parse(this.state.manualVerificationCompletedAt || '');
      if (confirmed !== true || !Number.isFinite(verifiedAt) || verifiedAt < this.state.pausedAt) return false;
      const pausedState = { ...this.state };
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
