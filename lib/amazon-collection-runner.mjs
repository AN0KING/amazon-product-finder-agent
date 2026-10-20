import { auditAmazonProductFields, AMAZON_DETAIL_QUALITY_VERSION } from './amazon-detail-quality.mjs';
import { amazonMonthlySalesValue } from './amazon-sales-policy.mjs';
import { extractAmazonFirstAvailableDate } from './amazon-listing-date.mjs';
import { hasCompleteProductInformationInspection } from './amazon-product-information.mjs';
import { validateDirectAsinStores } from './asin-list.mjs';
import { amazonCollectionRecoveryReason, MAX_AMAZON_COLLECTION_RECOVERIES } from './amazon-detail-retry.mjs';

const ACTIVE = new Set(['queued', 'running', 'cooldown']);
const RESTRICTIONS = new Set(['AMAZON_ACCESS_CHALLENGE', 'AMAZON_HTTP_429']);
const DISCOVERY_NETWORK_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'COLLECTION_TIMEOUT', 'AMAZON_FETCH_TIMEOUT',
  'AMAZON_FETCH_REQUEST_FAILED', 'AMAZON_REQUEST_FAILED', 'EDGE_CDP_CLOSED', 'EDGE_CDP_CONNECT_TIMEOUT']);
const clone = value => structuredClone(value);
const asinOf = value => String(value?.sourceAsin || value?.asin || '').toUpperCase();

export class AmazonCollectionRunner {
  constructor({ store, seed, discover, loadDetails, canRun = () => true, canMaintain = () => true, onBusy = () => {},
    now = () => Date.now(), intervalMs = 30_000, timeoutMs = 240_000, batchSize = 5,
    retryMs = 60_000, restrictionMs = 300_000, supplierLeaseMs = 120_000, recoveryMs = 60_000 } = {}) {
    Object.assign(this, { store, seed, discover, loadDetails, canRun, canMaintain, onBusy, now,
      intervalMs, timeoutMs, batchSize, retryMs, restrictionMs, supplierLeaseMs, recoveryMs });
    this.runId = null;
    this.timer = null;
    this.work = null;
    this.controller = null;
    this.generation = 0;
    this.closed = false;
    this.pausePending = false;
    this.controlQueue = Promise.resolve();
    this.profitCheck = null;
  }

  async initialize({ timer = true } = {}) {
    const saved = await this.store.getActiveAmazonCollection();
    if (saved?.job && saved.job.status !== 'cancelled' && !saved.job.archivedAt) {
      this.runId = saved.runId;
      if (saved.job.status === 'running') {
        await this.change(job => {
          job.status = 'queued';
          job.restartCount = (job.restartCount || 0) + 1;
          job.message = '服务已恢复，正在从已保存的断点继续。';
        });
      }
      await this.settlePreviouslyCollectedTasks(saved);
    }
    if (timer) {
      this.timer = setInterval(() => void this.tick().catch(error => this.log(error)), this.intervalMs);
      this.timer.unref?.();
      void this.tick().catch(error => this.log(error));
    }
    return this.status();
  }

  control(operation) {
    const next = this.controlQueue.then(operation, operation);
    this.controlQueue = next.catch(() => {});
    return next;
  }

  async start(runId) {
    return this.control(async () => {
      if (this.closed) throw collectionError('COLLECTION_CLOSED', '采集服务正在关闭。');
      const active = await this.status();
      if (active?.runId === runId && (active.archivedAt || active.status === 'cancelled')) {
        throw collectionError('RUN_ARCHIVED', '原任务已取消并归档，请上传新文件创建任务。');
      }
      if (active && active.runId !== runId && ACTIVE.has(active.status)) {
        throw collectionError('COLLECTION_BUSY', '已有后台采集任务，请先暂停该任务。');
      }
      if (active?.runId === runId) return active;
      const snapshot = await this.store.getRunSnapshot(runId);
      if (snapshot?.runState?.archivedAt || snapshot?.runState?.status === 'cancelled') {
        throw collectionError('RUN_ARCHIVED', '原任务已取消并归档，请上传新文件创建任务。');
      }
      if (!snapshot || snapshot.runState.analysisSourceMode !== 'amazon_only') {
        throw collectionError('INVALID_COLLECTION_RUN', '后台采集需要已保存的 Amazon 官网任务。', 422);
      }
      const inputMode = snapshot.storeList?.inputMode || snapshot.runState.inputMode || 'stores';
      if (inputMode === 'asins') validateDirectAsinStores(snapshot.storeList?.stores, snapshot.runState.marketplace);
      if (this.work) throw collectionError('COLLECTION_BUSY', '上一批请求正在退出，请稍后继续。');
      const previous = await this.store.getAmazonCollection(runId);
      if (previous.job?.archivedAt || previous.job?.status === 'cancelled') {
        throw collectionError('RUN_ARCHIVED', '原任务已取消并归档，不能恢复采集。');
      }
      this.runId = runId;
      if (previous.job) {
        await this.store.updateAmazonCollection(runId, value => value, { activate: true });
        await this.settlePreviouslyCollectedTasks(previous);
        return this.status();
      }
      const seeded = await this.seed(snapshot);
      const time = this.iso();
      const job = { id: runId, runId, owner: 'server', enabled: true, status: 'queued', inputMode,
        phase: seeded.discoveryComplete ? 'details' : 'discover', marketplace: snapshot.runState.marketplace,
        stores: clone(snapshot.storeList?.stores || []), filters: clone(snapshot.runState.criteria || {}),
        discoveryComplete: seeded.discoveryComplete === true, discoveryCursor: 0, discoveryAttempts: 0,
        revision: 1, createdAt: time, updatedAt: time, heartbeatAt: time, lastProgressAt: time,
        nextRetryAt: null, completedAt: null, causeCode: null, message: '后台采集已建立，等待下一批。',
        restrictionCount: 0, restartCount: 0, tasks: {} };
      const items = {};
      for (const target of seeded.targets || []) this.addTarget(job, target);
      for (const source of seeded.items || []) {
        const asin = asinOf(source);
        if (!job.tasks[asin] || source.detailStatus !== 'success') continue;
        const item = this.audit(source, job);
        items[asin] = item;
        const task = job.tasks[asin];
        task.attempts = 1;
        task.status = item.collectionQuality.requiredMissing.length ? 'partial' : 'complete';
      }
      this.summarize(job, items);
      await this.store.updateAmazonCollection(runId, () => ({ job, items }), { activate: true });
      return this.status();
    });
  }

  async cancelForReplacement(runId) {
    return this.control(async () => {
      if (this.closed) throw collectionError('COLLECTION_CLOSED', '采集服务正在关闭。');
      const ownsRun = this.runId === runId;
      if (ownsRun) {
        this.pausePending = true;
        this.generation += 1;
        this.controller?.abort(new Error('Collection replaced by a new upload.'));
      }
      try {
        if (ownsRun && this.work) await this.work;
        const { job } = await this.store.getAmazonCollection(runId);
        if (!job) return null;
        await this.store.archiveRun(runId);
        if (ownsRun) this.runId = null;
        const { job: archived } = await this.store.getAmazonCollection(runId);
        const { tasks, stores, filters, ...publicJob } = archived;
        return { ...publicJob, workerActive: false };
      } finally {
        if (ownsRun) this.pausePending = false;
      }
    });
  }

  async command(runId, action, { asins } = {}) {
    return this.control(async () => {
      if (this.runId !== runId) throw collectionError('COLLECTION_NOT_ACTIVE', '该任务不是当前后台采集任务。', 404);
      const savedJob = await this.readJob(runId);
      if (savedJob?.archivedAt || savedJob?.status === 'cancelled') {
        throw collectionError('RUN_ARCHIVED', '原任务已取消并归档，不能恢复采集。');
      }
      if (!['pause', 'resume', 'retry_missing', 'recheck', 'pause_for_supplier', 'resume_after_supplier'].includes(action)) throw collectionError('INVALID_COLLECTION_ACTION', '不支持的采集操作。', 422);
      if (action === 'recheck' && asins === undefined) {
        // Already inside control(): do not acquire that queue a second time.
        // The scheduler re-reads the active run and all protections/budgets.
        await this.scheduleAutomaticRecoveryLocked(runId, this.generation);
        return this.status();
      }
      if (asins !== undefined) {
        if (action !== 'retry_missing' || !Array.isArray(asins) || !asins.length || asins.length > 100
          || asins.some(asin => typeof asin !== 'string' || !/^[A-Z0-9]{10}$/i.test(asin))) {
          throw collectionError('INVALID_COLLECTION_ASINS', '指定补采仅支持 1 至 100 个有效 ASIN。', 422);
        }
        if (this.closed || this.work) throw collectionError('COLLECTION_BUSY', '采集尚未稳定停止，请稍后补采指定商品。');
        const selectedAsins = [...new Set(asins.map(asin => asin.toUpperCase()))];
        const { job, items } = await this.store.getAmazonCollection(runId);
        if (this.closed || this.work || job?.targetedRetry || !['completed', 'paused', 'needs_attention'].includes(job?.status)) {
          throw collectionError('COLLECTION_BUSY', '请先暂停当前采集，再补采指定商品。');
        }
        if (selectedAsins.some(asin => !Object.hasOwn(job.tasks, asin))) {
          throw collectionError('COLLECTION_ASIN_NOT_FOUND', '指定 ASIN 不在当前已保存的采集任务中。', 422);
        }
        const retryAsins = selectedAsins.filter(asin => job.tasks[asin].status === 'failed'
          || items[asin]?.collectionQuality?.requiredMissing?.length);
        if (!retryAsins.length) return this.status();
        await this.change(current => {
          const returnState = Object.fromEntries(['status', 'enabled', 'phase', 'nextRetryAt', 'causeCode', 'message',
            'completedAt', 'restrictionCount', 'discoveryAttempts', 'supplierPause'].map(key => [key, clone(current[key])]));
          current.targetedRetry = { asins: retryAsins, returnState, requestedAt: this.iso() };
          current.enabled = true; current.status = 'queued'; current.phase = 'details'; current.completedAt = null;
          current.nextRetryAt = null; current.causeCode = null; current.restrictionCount = 0;
          delete current.supplierPause;
          current.message = `仅补采指定的 ${retryAsins.length} 个缺项商品，其他商品断点保持不变。`;
          for (const asin of retryAsins) {
            current.tasks[asin].status = 'pending'; current.tasks[asin].attempts = 0; current.tasks[asin].nextRetryAt = null;
          }
        });
        return this.status();
      }
      if (action === 'pause' || action === 'pause_for_supplier') {
        this.pausePending = true;
        this.generation += 1;
        this.controller?.abort(new Error(action === 'pause' ? 'Collection manually paused.' : 'Collection yielding to supplier matching.'));
        try {
          if (action === 'pause') {
            await this.changeJob(job => {
              job.status = 'paused'; job.enabled = false; job.nextRetryAt = null; job.lastError = null;
              job.causeCode = 'USER_PAUSED'; job.message = '已手动暂停，定时检查不会擅自恢复。';
              delete job.supplierPause;
            });
          } else {
            const time = this.iso();
            const expiresAt = this.after(this.supplierLeaseMs);
            await this.updateJob(job => {
              if (isSupplierPaused(job)) {
                // Renewals must not invalidate a supplier snapshot being saved
                // against the same collection revision.
                job.supplierPause = { ...(job.supplierPause || {}), expiresAt };
              } else if (ACTIVE.has(job.status)) {
                job.supplierPause = { startedAt: time, expiresAt,
                  previousStatus: job.status, previousNextRetryAt: job.nextRetryAt,
                  previousCauseCode: job.causeCode };
                job.status = 'paused'; job.enabled = false; job.nextRetryAt = null;
                job.causeCode = 'SUPPLIER_MATCHING';
                job.message = '正在匹配 1688 厂家，Amazon 采集暂时让出；匹配结束后继续。';
                job.updatedAt = time;
                job.revision = (job.revision || 0) + 1;
              }
              // Manual pauses and terminal states are never converted into a
              // temporary pause that a supplier completion can undo.
              return job;
            });
          }
          if (this.work) await this.work;
          return await this.status();
        } finally {
          this.pausePending = false;
        }
      } else if (action === 'resume_after_supplier') {
        const job = await this.readJob();
        if (isSupplierPaused(job)) {
          if (this.work) await this.work;
          await this.changeJob(current => this.restoreAfterSupplier(current));
        }
      } else {
        if (this.work) throw collectionError('COLLECTION_BUSY', '上一批请求正在退出，请稍后继续。');
        await this.change((job, items) => {
          if (action === 'retry_missing') delete job.targetedRetry;
          job.enabled = true; job.status = 'queued'; job.completedAt = null;
          job.nextRetryAt = null; job.causeCode = null; job.restrictionCount = 0; job.discoveryAttempts = 0;
          delete job.supplierPause;
          job.message = action === 'retry_missing' ? '已按你的操作重新采集缺失字段商品；成功读取一次后保留页面实际提供的信息。' : '已恢复后台断点，等待继续采集。';
          for (const [asin, task] of Object.entries(job.tasks)) {
            if (!inRetryScope(job, asin)) continue;
            if (task.status === 'failed' || (action === 'retry_missing' && items[asin]?.collectionQuality?.requiredMissing?.length)) {
              task.status = 'pending'; task.attempts = 0; task.nextRetryAt = null;
            }
          }
        });
      }
      return this.status();
    });
  }

  async status() {
    if (!this.runId) return null;
    const job = await this.readJob();
    if (!job) return null;
    const { tasks, stores, filters, ...publicJob } = job;
    // Older completed snapshots may still contain the last transient timeout.
    // Keep it available as history without reporting an active collection fault.
    if (job.status === 'completed' && job.lastError) {
      publicJob.lastFailure ||= { code: null, message: job.lastError, at: null };
      publicJob.lastError = null;
    }
    return { ...publicJob, checkIntervalMs: this.intervalMs,
      nextCheckAt: ACTIVE.has(job.status) || hasPendingRecoveryCheck(job) || isRecoverableDiscovery(job)
        ? new Date(this.now() + this.intervalMs).toISOString() : null,
      workerActive: Boolean(this.work) };
  }

  async tick() {
    if (this.closed || this.pausePending || !this.runId) return;
    const generation = this.generation;
    const runId = this.runId;
    await this.repairPendingProfits(runId, generation);
    if (this.closed || this.pausePending || generation !== this.generation || runId !== this.runId || this.work || !this.canRun()) return;
    const job = await this.readJob();
    if (this.closed || this.pausePending || generation !== this.generation || runId !== this.runId || this.work || !this.canRun()) return;
    if (isRecoverableDiscovery(job)) {
      await this.control(async () => {
        if (this.closed || this.pausePending || this.work || runId !== this.runId || !this.canRun()) return;
        await this.changeJob(current => {
          if (!isRecoverableDiscovery(current)) return;
          const now = this.now();
          const attempts = (current.discoveryRecovery?.attempts || []).filter(time =>
            Number.isFinite(Date.parse(time)) && Date.parse(time) > now - 3_600_000);
          const delay = Math.min(1_800_000, 300_000 * 2 ** attempts.length);
          current.nextRetryAt = new Date(Math.max(now + delay,
            attempts.length >= 5 ? Date.parse(attempts[0]) + 3_600_000 : now)).toISOString();
          if (attempts.length < 5) attempts.push(this.iso());
          current.discoveryRecovery = { attempts, reasonCode: current.causeCode, scheduledAt: this.iso() };
          current.discoveryAttempts = 0;
          current.status = 'cooldown';
          current.message = '店铺枚举因网络中断停止，已安排延长冷却；到期从原分页断点自动继续。';
        }, { runId, generation });
      });
      return;
    }
    if (isSupplierPaused(job)) {
      if (!supplierLeaseExpired(job, this.now())) return;
      const restored = await this.control(async () => {
        if (this.closed || this.pausePending || this.work || runId !== this.runId || !this.canRun()) return false;
        const current = await this.readJob(runId);
        if (this.closed || this.pausePending || this.work || runId !== this.runId || !this.canRun()
          || !isSupplierPaused(current) || !supplierLeaseExpired(current, this.now())) return false;
        await this.changeJob(value => this.restoreAfterSupplier(value, true));
        return true;
      });
      if (restored) return this.tick();
      return;
    }
    if (job?.status === 'completed' && job.enabled && !job.targetedRetry) {
      const recovered = await this.scheduleAutomaticRecovery(runId, generation);
      if (recovered) return this.tick();
      return;
    }
    if (!job || !job.enabled || !ACTIVE.has(job.status)) return;
    if (job.nextRetryAt && Date.parse(job.nextRetryAt) > this.now()) return;
    // Recheck after the awaited read: two timer/control callers may arrive together.
    if (this.closed || this.pausePending || generation !== this.generation || runId !== this.runId || this.work || !this.canRun()) return;
    const controller = new AbortController();
    this.controller = controller;
    this.onBusy(true);
    this.work = this.perform(job, controller, generation).finally(() => {
      this.controller = null; this.work = null; this.onBusy(false);
      if (this.timer && !this.closed) {
        const next = setTimeout(() => void this.tick().catch(error => this.log(error)), 1_000);
        next.unref?.();
      }
    });
    return this.work;
  }

  async repairPendingProfits(runId, generation) {
    if (!this.store.repairPendingProfits) return;
    await this.control(async () => {
      const canCommit = () => !this.closed && !this.pausePending && this.canMaintain()
        && this.runId === runId && this.generation === generation;
      if (!canCommit() || (this.profitCheck?.runId === runId && this.now() - this.profitCheck.at < 60_000)) return;
      const result = await this.store.repairPendingProfits(runId, { canCommit });
      if (result) this.profitCheck = { runId, at: this.now(), ...result };
    });
  }

  async scheduleAutomaticRecovery(runId, generation) {
    return this.control(() => this.scheduleAutomaticRecoveryLocked(runId, generation));
  }

  async scheduleAutomaticRecoveryLocked(runId, generation) {
      const ownsRun = () => !this.closed && !this.pausePending && !this.work && this.canRun()
        && this.runId === runId && this.generation === generation;
      if (!ownsRun()) return false;
      const saved = await this.store.getAmazonCollection(runId);
      const eligibleJob = job => job?.status === 'completed' && job.enabled && !job.archivedAt
        && !job.targetedRetry && !job.supplierPause && !job.causeCode;
      if (!ownsRun() || !eligibleJob(saved.job)) return false;
      const candidates = Object.entries(saved.job.tasks).filter(([asin, task]) =>
        ['complete', 'partial', 'failed'].includes(task.status)
        && (task.automaticRecoveryAttempts || 0) < MAX_AMAZON_COLLECTION_RECOVERIES
        && amazonCollectionRecoveryReason(saved.items[asin], task));
      if (!candidates.length) return false;
      let scheduled = false;
      await this.change((job, items) => {
        if (!ownsRun() || !eligibleJob(job)) return;
        for (const [asin] of candidates) {
          const task = job.tasks[asin];
          const reason = amazonCollectionRecoveryReason(items[asin], task);
          if (!reason || !['complete', 'partial', 'failed'].includes(task.status)
            || (task.automaticRecoveryAttempts || 0) >= MAX_AMAZON_COLLECTION_RECOVERIES) continue;
          const previous = task.automaticRecoveryAttempts || 0;
          const lastCheck = Date.parse(items[asin]?.collectionRecovery?.checkedAt || job.completedAt || job.updatedAt || '') || this.now();
          task.automaticRecoveryAttempts = previous + 1;
          task.recoveryPending = true;
          task.status = 'pending';
          task.nextRetryAt = new Date(Math.max(this.now(), lastCheck + this.recoveryMs * 2 ** previous)).toISOString();
          const item = items[asin] ||= { asin, sourceAsin: asin, marketplace: job.marketplace,
            detailStatus: 'failed', detailErrorCode: task.lastCode || reason.reasonCode };
          item.collectionRecovery = { status: 'scheduled', attempts: task.automaticRecoveryAttempts,
            maxAttempts: MAX_AMAZON_COLLECTION_RECOVERIES, ...reason, nextRetryAt: task.nextRetryAt,
            checkedAt: this.iso() };
          scheduled = true;
        }
        if (scheduled) {
          job.phase = 'details'; job.completedAt = null;
          this.advance(job);
          job.message = '发现可补查的访问失败或未完成信息检查，将按冷却时间自动重新核对；每个商品最多额外补查 2 次。';
        }
      }, { runId, generation });
      return scheduled;
  }

  async perform(savedJob, controller, generation) {
    const runId = savedJob.runId;
    // A queued write may execute after a manual pause has already won. Check
    // ownership inside the store callback, not only before awaiting persistence.
    const change = update => this.change(update, { runId, generation });
    let activeAsins = [];
    const committedAsins = new Set();
    let itemQueue = Promise.resolve();
    let itemWriteError = null;
    let batchRestriction = null;
    let acceptingItems = true;
    try {
      await this.changeJob(job => {
        job.status = 'running'; job.nextRetryAt = null; job.heartbeatAt = this.iso();
        job.message = job.phase === 'discover' ? '后台正在获取店铺商品，并检查已有断点。' : '后台正在同步采集价格、重量和商品信息。';
      }, { runId, generation });
      const job = await this.readJob(runId);
      if (generation !== this.generation || this.closed || controller.signal.aborted) return;
      if (job.phase === 'discover') {
        const result = await this.withDeadline(() => this.discover(job, controller.signal), controller);
        if (generation !== this.generation || controller.signal.aborted) return;
        await change((current, items) => {
          current.lastError = null;
          for (const target of result.targets || []) this.addTarget(current, target);
          for (const item of result.items || []) {
            const asin = asinOf(item);
            if (asin && !items[asin]) items[asin] = this.audit(item, current);
          }
          current.discoveryCursor = result.cursor ?? current.discoveryCursor;
          current.discoveryComplete = result.complete === true;
          current.storeVisits = result.storeVisits || current.storeVisits;
          current.visitAudit = result.visitAudit || current.visitAudit;
          if (result.progressed !== false) {
            current.lastProgressAt = this.iso();
            current.causeCode = null;
          }
          if (result.restrictionCode) this.restrict(current, result.restrictionCode);
          else if (result.terminalCode) {
            current.status = 'needs_attention'; current.causeCode = result.terminalCode;
            current.message = result.message || '店铺采集已保存断点，需要检查后继续。';
          } else {
            if (!current.discoveryComplete && result.progressed === false) {
              current.discoveryAttempts += 1;
              current.status = current.discoveryAttempts >= 3 ? 'needs_attention' : 'cooldown';
              current.causeCode = result.failure?.code || 'AMAZON_DISCOVERY_NO_PROGRESS';
              if (result.failure) {
                current.lastError = result.failure.message || result.failure.code;
                current.lastFailure = { code: result.failure.code, message: current.lastError, at: this.iso() };
              }
              current.nextRetryAt = current.discoveryAttempts >= 3 ? null : this.after(this.retryMs * 2 ** (current.discoveryAttempts - 1));
              current.message = current.discoveryAttempts >= 3
                ? '店铺连续三次没有采集进展，已保存断点，请检查店铺访问后继续。'
                : '店铺暂时没有返回新数据，冷却后自动检查断点。';
              return;
            }
            current.phase = Object.values(current.tasks).some(task => task.status === 'pending') || current.discoveryComplete ? 'details' : 'discover';
            current.status = 'queued'; current.discoveryAttempts = 0;
          }
        });
        return;
      }
      activeAsins = Object.entries(job.tasks).filter(([asin, task]) => inRetryScope(job, asin) && task.status === 'pending'
        && (!task.nextRetryAt || Date.parse(task.nextRetryAt) <= this.now()))
        .slice(0, this.batchSize).map(([asin]) => asin);
      if (!activeAsins.length) {
        await change((current) => this.advance(current));
        return;
      }
      // A loader may finish products concurrently. Each accepted result is
      // committed once before its callback resolves, even if the batch tail
      // later times out. Manual pause/replacement still fences queued writes.
      const onItem = source => {
        const asin = asinOf(source);
        if (!acceptingItems || controller.signal.aborted || generation !== this.generation
          || this.closed || !activeAsins.includes(asin)) return Promise.resolve(false);
        const received = clone(source);
        const pending = itemQueue.then(async () => {
          if (itemWriteError) throw itemWriteError;
          if (committedAsins.has(asin) || batchRestriction === 'AMAZON_ACCESS_CHALLENGE'
            || generation !== this.generation || this.closed || this.runId !== runId) return false;
          let applied = false;
          let nextRestriction = batchRestriction;
          await this.change((current, items) => {
            const restriction = this.recordDetail(current, items, received);
            applied = true;
            if (restriction && nextRestriction !== 'AMAZON_ACCESS_CHALLENGE') {
              if (!nextRestriction || restriction === 'AMAZON_ACCESS_CHALLENGE') {
                // One failed batch consumes one restriction step, including a
                // later challenge superseding an earlier HTTP 429 response.
                if (nextRestriction) current.restrictionCount = Math.max(0, (current.restrictionCount || 0) - 1);
                nextRestriction = restriction;
                this.restrict(current, restriction);
              }
            }
            current.lastProgressAt = this.iso();
            current.heartbeatAt = this.iso();
            if (!nextRestriction) {
              current.lastError = null;
              if (committedAsins.size + 1 === activeAsins.length) this.advance(current);
              else current.message = '已保存当前商品并计算结果，继续采集后续商品。';
            }
          }, { runId, generation, changedAsins: [asin] });
          if (!applied) return false;
          batchRestriction = nextRestriction;
          committedAsins.add(asin);
          if (batchRestriction === 'AMAZON_ACCESS_CHALLENGE') {
            controller.abort(collectionError('AMAZON_ACCESS_CHALLENGE', 'Amazon 页面要求访问验证，已保存断点。'));
          }
          return true;
        });
        itemQueue = pending.catch(error => { itemWriteError ||= error; });
        return pending;
      };
      const results = await this.withDeadline(() => this.loadDetails(job, activeAsins, controller.signal, onItem), controller);
      await itemQueue;
      if (itemWriteError) throw itemWriteError;
      if (generation !== this.generation || controller.signal.aborted) return;
      // Old loaders may return only an array. Stream-aware loaders can return
      // the same records: committed ASINs are never counted or saved twice.
      for (const asin of activeAsins) {
        if (committedAsins.has(asin)) continue;
        const source = (Array.isArray(results) ? results : []).find(item => asinOf(item) === asin) || {
          asin, sourceAsin: asin, marketplace: job.marketplace, detailStatus: 'failed',
          detailRetryable: true, detailErrorCode: 'AMAZON_DETAIL_NOT_RETURNED',
        };
        await onItem(source);
        if (controller.signal.aborted || generation !== this.generation) return;
      }
    } catch (error) {
      acceptingItems = false;
      // Stop new callbacks, but await callbacks already received before the
      // failed tail so their durable successes cannot be marked failed again.
      if (!controller.signal.aborted) controller.abort(error);
      await itemQueue;
      if (generation !== this.generation || this.closed || batchRestriction === 'AMAZON_ACCESS_CHALLENGE') return;
      const remainingAsins = activeAsins.filter(asin => !committedAsins.has(asin));
      if (activeAsins.length && !remainingAsins.length) return;
      await change((job, items) => {
        job.lastError = String(error.message || error).slice(0, 500);
        job.causeCode = error.code || 'COLLECTION_REQUEST_FAILED';
        job.lastFailure = { code: job.causeCode, message: job.lastError, at: this.iso() };
        for (const asin of remainingAsins) {
          const task = job.tasks[asin];
          task.attempts += 1; task.lastCode = job.causeCode;
          const recovery = task.recoveryPending === true;
          task.recoveryPending = false;
          task.status = recovery || task.attempts >= 3 ? 'failed' : 'pending';
          task.nextRetryAt = task.status === 'pending' ? this.after(this.retryMs * 2 ** Math.min(task.attempts - 1, 3)) : null;
          const failure = { asin, sourceAsin: asin, marketplace: job.marketplace, detailStatus: 'failed',
            detailRetryable: true, detailErrorCode: job.causeCode, detailError: job.lastError, collectedAt: this.iso() };
          if (items[asin]?.detailStatus === 'success') {
            items[asin] = { ...items[asin], collectionQuality: this.audit(failure, job).collectionQuality,
              lastCollectionError: { code: job.causeCode, message: job.lastError, checkedAt: this.iso() } };
          } else items[asin] = this.audit(failure, job);
          if (recovery) this.recordRecoveryResult(items[asin], task);
        }
        if (RESTRICTIONS.has(error.code) && (!batchRestriction || error.code === 'AMAZON_ACCESS_CHALLENGE')) {
          if (batchRestriction) job.restrictionCount = Math.max(0, (job.restrictionCount || 0) - 1);
          this.restrict(job, error.code);
        } else if (batchRestriction) {
          job.causeCode = batchRestriction;
        } else if (job.phase === 'discover' && ++job.discoveryAttempts >= 3) {
          job.status = 'needs_attention'; job.message = '店铺枚举连续失败，断点已保存，请检查后继续。';
        } else {
          job.status = 'cooldown'; job.nextRetryAt = this.after(this.retryMs);
          job.message = '检测到请求中断或超时，断点已保存，将自动继续。';
        }
      });
    } finally {
      acceptingItems = false;
    }
  }

  recordDetail(job, items, source) {
    const asin = asinOf(source);
    const item = this.audit(source, job);
    const task = job.tasks[asin];
    const recovery = task.recoveryPending === true;
    task.recoveryPending = false;
    task.attempts += 1;
    task.lastCode = item.detailErrorCode || null;
    task.nextRetryAt = null;
    // Failed refreshes retain earlier successful raw data. Their failure audit
    // is explicit and must never look like a newly observed price or weight.
    if (item.detailStatus !== 'success' && items[asin]?.detailStatus === 'success') {
      items[asin] = { ...items[asin], collectionQuality: item.collectionQuality,
        lastCollectionError: { code: item.detailErrorCode, message: item.detailError || null, checkedAt: this.iso() } };
    } else items[asin] = item;
    if (item.detailStatus === 'success') {
      task.status = item.collectionQuality.requiredMissing.length ? 'partial' : 'complete';
    } else if (!recovery && item.detailRetryable !== false && task.attempts < 3) {
      task.status = 'pending'; task.nextRetryAt = this.after(this.retryMs * 2 ** (task.attempts - 1));
    } else task.status = 'failed';
    if (recovery) this.recordRecoveryResult(items[asin], task);
    return RESTRICTIONS.has(item.detailErrorCode) ? item.detailErrorCode : null;
  }

  recordRecoveryResult(item, task) {
    const reason = amazonCollectionRecoveryReason(item, task);
    const exhausted = (task.automaticRecoveryAttempts || 0) >= MAX_AMAZON_COLLECTION_RECOVERIES;
    const failed = item.detailStatus !== 'success' || Boolean(item.lastCollectionError);
    item.collectionRecovery = { attempts: task.automaticRecoveryAttempts || 0,
      maxAttempts: MAX_AMAZON_COLLECTION_RECOVERIES,
      status: reason ? exhausted ? 'exhausted' : 'waiting' : failed ? 'blocked' : 'resolved',
      reasonCode: reason?.reasonCode || (failed ? task.lastCode : null),
      message: reason ? `${reason.message}${exhausted ? '；已达到自动补查上限，保留原因等待处理' : '；冷却后将再次核对'}`
        : failed ? item.lastCollectionError?.message || item.detailError || '访问失败，需要检查后处理'
          : '本次商品页面检查已完成',
      nextRetryAt: reason && !exhausted ? this.after(this.recoveryMs * 2 ** (task.automaticRecoveryAttempts || 0)) : null,
      checkedAt: this.iso() };
  }

  async withDeadline(operation, controller) {
    let timer;
    let listener;
    try {
      controller.signal.throwIfAborted();
      const cancellation = new Promise((_, reject) => {
        listener = () => reject(controller.signal.reason || new Error('Collection interrupted.'));
        controller.signal.addEventListener('abort', listener, { once: true });
        timer = setTimeout(() => controller.abort(collectionError('COLLECTION_TIMEOUT', '采集请求超时，已保存断点。', 504)), this.timeoutMs);
      });
      return await Promise.race([Promise.resolve().then(() => {
        // A pause may arrive between creating the deadline and this microtask.
        controller.signal.throwIfAborted();
        return operation();
      }), cancellation]);
    } finally {
      clearTimeout(timer);
      if (listener) controller.signal.removeEventListener('abort', listener);
    }
  }

  advance(job) {
    const pending = Object.entries(job.tasks).filter(([asin, task]) => inRetryScope(job, asin) && task.status === 'pending').map(([, task]) => task);
    job.causeCode = null;
    job.lastError = null;
    if (pending.length) {
      const next = Math.min(...pending.map(task => Date.parse(task.nextRetryAt || '') || this.now()));
      job.status = next > this.now() ? 'cooldown' : 'queued';
      job.nextRetryAt = next > this.now() ? new Date(next).toISOString() : null;
      job.message = next > this.now() ? '等待短暂请求故障冷却，届时自动继续。' : '已保存本批价格和重量，继续后续商品。';
    } else if (job.targetedRetry) {
      const { returnState } = job.targetedRetry;
      Object.assign(job, returnState);
      if (job.status === 'completed') job.completedAt = this.iso();
      delete job.targetedRetry;
    } else if (!job.discoveryComplete) {
      job.phase = 'discover'; job.status = 'queued'; job.nextRetryAt = null;
    } else {
      job.status = 'completed'; job.completedAt = this.iso(); job.nextRetryAt = null;
      const incomplete = Object.values(job.tasks).filter(task => ['partial', 'failed'].includes(task.status)).length;
      job.message = incomplete ? `本轮采集结束，${incomplete} 个商品仍有缺失字段或访问失败，已保留原因。` : '本轮商品信息采集及必需字段检查完成。';
    }
  }

  restrict(job, code) {
    job.restrictionCount = (job.restrictionCount || 0) + 1;
    job.causeCode = code;
    if (code === 'AMAZON_ACCESS_CHALLENGE') {
      job.status = 'needs_attention'; job.enabled = false; job.nextRetryAt = null;
      job.message = 'Amazon 页面要求访问验证，已停止自动请求并保存断点；请在浏览器处理验证后手动继续。';
    } else if (job.restrictionCount >= 3) {
      job.status = 'needs_attention'; job.nextRetryAt = null;
      job.message = 'Amazon 持续限制请求，已停止自动请求并保存断点；恢复访问后可继续。';
    } else {
      job.status = 'cooldown';
      job.nextRetryAt = this.after(this.restrictionMs * 2 ** (job.restrictionCount - 1));
      job.message = 'Amazon 暂时限制访问，已进入较长冷却；到期检查后从断点继续。';
    }
  }

  addTarget(job, target) {
    const asin = asinOf(target);
    if (!/^[A-Z0-9]{10}$/.test(asin)) return;
    if (!job.tasks[asin]) job.tasks[asin] = { status: 'pending', attempts: 0, nextRetryAt: null, sourceStores: target.sourceStores || [] };
    else if (target.sourceStores?.length) job.tasks[asin].sourceStores = target.sourceStores;
    const sales30 = amazonMonthlySalesValue(target);
    if (sales30 !== null) {
      job.tasks[asin].sales30 = sales30;
      job.tasks[asin].sales30Evidence = clone(target.sales30Evidence);
    }
  }

  audit(item, job) {
    if (item.productInformation?.weightStatus === 'not_provided'
      && !hasCompleteProductInformationInspection(item.productInformation, asinOf(item))) {
      item = { ...item, productInformation: { ...item.productInformation, weightStatus: 'unresolved' } };
    }
    return { ...item, collectionQuality: auditAmazonProductFields(item, { marketplace: job.marketplace, now: this.iso() }) };
  }

  async settlePreviouslyCollectedTasks(saved) {
    const hasPendingVisit = Object.entries(saved?.job?.tasks || {}).some(([asin, task]) => inRetryScope(saved.job, asin) && hasSuccessfulPendingVisit(task, saved.items?.[asin]));
    const outdatedQuality = item => item?.detailStatus === 'success' && !item.lastCollectionError
      && item.collectionQuality?.version !== AMAZON_DETAIL_QUALITY_VERSION;
    const needsListingDate = item => item && !item.manualAmazonFields?.amazonFirstAvailableDate
      && item.fieldSources?.amazonFirstAvailableDate !== 'manual'
      && (item.productInformation && !Object.hasOwn(item, 'amazonFirstAvailableDateStatus')
        || item.amazonFirstAvailableDateStatus === 'not_provided'
          && !hasCompleteProductInformationInspection(item.productInformation, asinOf(item)));
    const hasMissingListingDate = Object.keys(saved?.job?.tasks || {}).some(asin => needsListingDate(saved.items?.[asin]));
    if (!hasPendingVisit && !hasMissingListingDate && !Object.values(saved?.items || {}).some(outdatedQuality)) return;
    await this.change((job, items) => {
      for (const [asin, task] of Object.entries(job.tasks)) {
        // Reuse saved, ASIN-bound evidence without scheduling a fresh visit or changing a pause.
        if (needsListingDate(items[asin])) {
          Object.assign(items[asin], extractAmazonFirstAvailableDate(items[asin].productInformation, { asin, marketplace: job.marketplace }));
        }
        if (outdatedQuality(items[asin])) {
          items[asin] = this.audit(items[asin], job);
          if (['complete', 'partial'].includes(task.status)) task.status = items[asin].collectionQuality.requiredMissing.length ? 'partial' : 'complete';
        }
        if (!inRetryScope(job, asin)) continue;
        if (!hasSuccessfulPendingVisit(task, items[asin])) continue;
        items[asin] = this.audit(items[asin], job);
        task.status = items[asin].collectionQuality.requiredMissing.length ? 'partial' : 'complete';
        task.nextRetryAt = null;
      }
      // Migrate the old missing-field retry policy without undoing manual,
      // supplier or access-restriction pauses. Explicit retries have attempts=0.
      if (hasPendingVisit && ACTIVE.has(job.status) && job.phase === 'details' && !RESTRICTIONS.has(job.causeCode)) this.advance(job);
    });
  }

  summarize(job, items) {
    const tasks = Object.values(job.tasks);
    job.counts = { total: tasks.length, processed: Object.values(items).filter(item => item.detailStatus !== 'pending').length,
      pending: tasks.filter(task => task.status === 'pending').length,
      complete: tasks.filter(task => task.status === 'complete').length,
      partial: tasks.filter(task => task.status === 'partial').length,
      failed: tasks.filter(task => task.status === 'failed').length };
    job.quality = Object.fromEntries(['price', 'weight', 'title', 'image', 'rating', 'reviews', 'sales30', 'salesAmount30']
      .map(field => [field, { verified: 0, missing: 0, unavailable: 0, invalid: 0 }]));
    job.recovery = { eligible: 0, scheduled: 0, exhausted: 0, blocked: 0 };
    for (const asin of Object.keys(job.tasks)) {
      const task = job.tasks[asin];
      const reason = amazonCollectionRecoveryReason(items[asin], task);
      if (task.recoveryPending) job.recovery.scheduled += 1;
      else if (['complete', 'partial', 'failed'].includes(task.status) && reason) {
        job.recovery[(task.automaticRecoveryAttempts || 0) >= MAX_AMAZON_COLLECTION_RECOVERIES ? 'exhausted' : 'eligible'] += 1;
      } else if (task.status === 'failed') job.recovery.blocked += 1;
      for (const field of Object.keys(job.quality)) {
        const status = items[asin]?.collectionQuality?.fields?.[field]?.status || 'missing';
        if (Object.hasOwn(job.quality[field], status)) job.quality[field][status] += 1;
      }
    }
  }

  async readJob(runId = this.runId) {
    return this.store.getAmazonCollectionJob
      ? this.store.getAmazonCollectionJob(runId)
      : (await this.store.getAmazonCollection(runId)).job;
  }

  async updateJob(update, runId = this.runId) {
    if (this.store.updateAmazonCollectionJob) return this.store.updateAmazonCollectionJob(runId, update);
    const saved = await this.store.updateAmazonCollection(runId, value => {
      value.job = update(value.job);
      return value;
    });
    return saved.job;
  }

  async changeJob(update, { runId = this.runId, generation } = {}) {
    const time = this.iso();
    return this.updateJob(job => {
      if (generation !== undefined && (generation !== this.generation || runId !== this.runId || this.closed)) return job;
      update(job);
      job.updatedAt = time;
      job.revision = (job.revision || 0) + 1;
      return job;
    }, runId);
  }

  async change(update, { runId = this.runId, generation, changedAsins } = {}) {
    const time = this.iso();
    return this.store.updateAmazonCollection(runId, value => {
      if (generation !== undefined && (generation !== this.generation || runId !== this.runId || this.closed)) return value;
      update(value.job, value.items);
      value.job.updatedAt = time;
      value.job.revision = (value.job.revision || 0) + 1;
      this.summarize(value.job, value.items);
      return value;
    }, changedAsins ? { changedAsins } : undefined);
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.generation += 1;
    this.controller?.abort(new Error('Local service is restarting.'));
    if (this.work) await this.work;
    if (this.runId && (await this.readJob())?.status === 'running') {
      await this.changeJob(job => { job.status = 'queued'; job.message = '服务重启后将继续已保存的断点。'; });
    }
  }

  restoreAfterSupplier(job, expired = false) {
    if (!isSupplierPaused(job)) return;
    const previous = job.supplierPause || {};
    job.status = previous.previousStatus === 'cooldown' ? 'cooldown' : 'queued';
    job.enabled = true;
    job.nextRetryAt = previous.previousNextRetryAt || null;
    job.causeCode = previous.previousCauseCode || null;
    job.message = expired ? '1688 匹配占用已到期，正在从保存的 Amazon 断点继续。'
      : job.status === 'cooldown' ? '1688 匹配已结束，继续等待原有采集冷却。' : '1688 匹配已结束，正在继续 Amazon 采集。';
    delete job.supplierPause;
  }

  iso() { return new Date(this.now()).toISOString(); }
  after(ms) { return new Date(this.now() + ms).toISOString(); }
  log(error) { process.stderr.write(`Amazon collection: ${error.code || error.message}\n`); }
}

function isSupplierPaused(job) {
  return job?.status === 'paused' && job.causeCode === 'SUPPLIER_MATCHING';
}

function isRecoverableDiscovery(job) {
  return job?.enabled === true && job.status === 'needs_attention' && job.phase === 'discover'
    && !job.discoveryComplete && !job.archivedAt && !job.targetedRetry && !job.supplierPause
    && DISCOVERY_NETWORK_ERRORS.has(job.causeCode);
}

function supplierLeaseExpired(job, now) {
  const expiresAt = Date.parse(job.supplierPause?.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function hasSuccessfulPendingVisit(task, item) {
  return task?.status === 'pending' && task.recoveryPending !== true && task.attempts > 0 && !task.lastCode
    && item?.detailStatus === 'success' && !item.lastCollectionError;
}

function inRetryScope(job, asin) {
  return !Array.isArray(job?.targetedRetry?.asins) || job.targetedRetry.asins.includes(asin);
}

function hasPendingRecoveryCheck(job) {
  if (job.status !== 'completed' || !job.enabled || job.causeCode || job.archivedAt || job.targetedRetry || job.supplierPause) return false;
  if (job.recovery) return job.recovery.eligible > 0 || job.recovery.scheduled > 0;
  // Older persisted jobs have no aggregate. A terminal partial/failed task
  // still warrants one read of its evidence; status itself remains read-only.
  return Object.values(job.tasks || {}).some(task => ['partial', 'failed'].includes(task.status)
    && (task.automaticRecoveryAttempts || 0) < MAX_AMAZON_COLLECTION_RECOVERIES);
}

function collectionError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}
