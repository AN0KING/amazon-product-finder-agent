import { auditAmazonProductFields } from './amazon-detail-quality.mjs';
import { amazonMonthlySalesValue } from './amazon-sales-policy.mjs';

const ACTIVE = new Set(['queued', 'running', 'cooldown']);
const RESTRICTIONS = new Set(['AMAZON_ACCESS_CHALLENGE', 'AMAZON_HTTP_429']);
const clone = value => structuredClone(value);
const asinOf = value => String(value?.sourceAsin || value?.asin || '').toUpperCase();

export class AmazonCollectionRunner {
  constructor({ store, seed, discover, loadDetails, canRun = () => true, onBusy = () => {},
    now = () => Date.now(), intervalMs = 30_000, timeoutMs = 240_000, batchSize = 5,
    retryMs = 60_000, restrictionMs = 300_000, supplierLeaseMs = 120_000 } = {}) {
    Object.assign(this, { store, seed, discover, loadDetails, canRun, onBusy, now,
      intervalMs, timeoutMs, batchSize, retryMs, restrictionMs, supplierLeaseMs });
    this.runId = null;
    this.timer = null;
    this.work = null;
    this.controller = null;
    this.generation = 0;
    this.closed = false;
    this.pausePending = false;
    this.controlQueue = Promise.resolve();
  }

  async initialize({ timer = true } = {}) {
    const saved = await this.store.getActiveAmazonCollection();
    if (saved?.job) {
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
      if (active && active.runId !== runId && ACTIVE.has(active.status)) {
        throw collectionError('COLLECTION_BUSY', '已有后台采集任务，请先暂停该任务。');
      }
      if (active?.runId === runId) return active;
      const snapshot = await this.store.getRunSnapshot(runId);
      if (!snapshot || snapshot.runState.analysisSourceMode !== 'amazon_only') {
        throw collectionError('INVALID_COLLECTION_RUN', '后台采集需要已保存的 Amazon 官网任务。', 422);
      }
      if (this.work) throw collectionError('COLLECTION_BUSY', '上一批请求正在退出，请稍后继续。');
      const previous = await this.store.getAmazonCollection(runId);
      this.runId = runId;
      if (previous.job) {
        await this.store.updateAmazonCollection(runId, value => value, { activate: true });
        await this.settlePreviouslyCollectedTasks(previous);
        return this.status();
      }
      const seeded = await this.seed(snapshot);
      const time = this.iso();
      const job = { id: runId, runId, owner: 'server', enabled: true, status: 'queued',
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

  async command(runId, action, { asins } = {}) {
    return this.control(async () => {
      if (this.runId !== runId) throw collectionError('COLLECTION_NOT_ACTIVE', '该任务不是当前后台采集任务。', 404);
      if (!['pause', 'resume', 'retry_missing', 'pause_for_supplier', 'resume_after_supplier'].includes(action)) throw collectionError('INVALID_COLLECTION_ACTION', '不支持的采集操作。', 422);
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
            await this.change(job => {
              job.status = 'paused'; job.enabled = false; job.nextRetryAt = null;
              job.causeCode = 'USER_PAUSED'; job.message = '已手动暂停，定时检查不会擅自恢复。';
              delete job.supplierPause;
            });
          } else {
            const time = this.iso();
            const expiresAt = this.after(this.supplierLeaseMs);
            await this.store.updateAmazonCollection(this.runId, value => {
              const job = value.job;
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
                this.summarize(job, value.items);
              }
              // Manual pauses and terminal states are never converted into a
              // temporary pause that a supplier completion can undo.
              return value;
            });
          }
          if (this.work) await this.work;
          return await this.status();
        } finally {
          this.pausePending = false;
        }
      } else if (action === 'resume_after_supplier') {
        const { job } = await this.store.getAmazonCollection(this.runId);
        if (isSupplierPaused(job)) {
          if (this.work) await this.work;
          await this.change(current => this.restoreAfterSupplier(current));
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
    const { job } = await this.store.getAmazonCollection(this.runId);
    if (!job) return null;
    const { tasks, stores, filters, ...publicJob } = job;
    return { ...publicJob, checkIntervalMs: this.intervalMs,
      nextCheckAt: ACTIVE.has(job.status) ? new Date(this.now() + this.intervalMs).toISOString() : null,
      workerActive: Boolean(this.work) };
  }

  async tick() {
    if (this.closed || this.pausePending || this.work || !this.runId || !this.canRun()) return;
    const generation = this.generation;
    const runId = this.runId;
    const { job } = await this.store.getAmazonCollection(this.runId);
    if (this.closed || this.pausePending || generation !== this.generation || runId !== this.runId || this.work || !this.canRun()) return;
    if (isSupplierPaused(job)) {
      if (!supplierLeaseExpired(job, this.now())) return;
      const restored = await this.control(async () => {
        if (this.closed || this.pausePending || this.work || runId !== this.runId || !this.canRun()) return false;
        const { job: current } = await this.store.getAmazonCollection(runId);
        if (this.closed || this.pausePending || this.work || runId !== this.runId || !this.canRun()
          || !isSupplierPaused(current) || !supplierLeaseExpired(current, this.now())) return false;
        await this.change(value => this.restoreAfterSupplier(value, true));
        return true;
      });
      if (restored) return this.tick();
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

  async perform(savedJob, controller, generation) {
    let activeAsins = [];
    try {
      await this.change(job => {
        job.status = 'running'; job.nextRetryAt = null; job.heartbeatAt = this.iso();
        job.message = job.phase === 'discover' ? '后台正在获取店铺商品，并检查已有断点。' : '后台正在同步采集价格、重量和商品信息。';
      });
      const { job } = await this.store.getAmazonCollection(this.runId);
      if (generation !== this.generation) return;
      if (job.phase === 'discover') {
        const result = await this.withDeadline(() => this.discover(job, controller.signal), controller);
        if (generation !== this.generation || controller.signal.aborted) return;
        await this.change((current, items) => {
          for (const target of result.targets || []) this.addTarget(current, target);
          for (const item of result.items || []) {
            const asin = asinOf(item);
            if (asin && !items[asin]) items[asin] = this.audit(item, current);
          }
          current.discoveryCursor = result.cursor ?? current.discoveryCursor;
          current.discoveryComplete = result.complete === true;
          current.storeVisits = result.storeVisits || current.storeVisits;
          current.visitAudit = result.visitAudit || current.visitAudit;
          if (result.progressed !== false) current.lastProgressAt = this.iso();
          if (result.restrictionCode) this.restrict(current, result.restrictionCode);
          else if (result.terminalCode) {
            current.status = 'needs_attention'; current.causeCode = result.terminalCode;
            current.message = result.message || '店铺采集已保存断点，需要检查后继续。';
          } else {
            if (!current.discoveryComplete && result.progressed === false) {
              current.discoveryAttempts += 1;
              current.status = current.discoveryAttempts >= 3 ? 'needs_attention' : 'cooldown';
              current.causeCode = 'AMAZON_DISCOVERY_NO_PROGRESS';
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
        await this.change((current) => this.advance(current));
        return;
      }
      const results = await this.withDeadline(() => this.loadDetails(job, activeAsins, controller.signal), controller);
      if (generation !== this.generation || controller.signal.aborted) return;
      await this.change((current, items) => {
        let restriction = null;
        for (const asin of activeAsins) {
          const source = results.find(item => asinOf(item) === asin) || {
            asin, sourceAsin: asin, marketplace: current.marketplace, detailStatus: 'failed',
            detailRetryable: true, detailErrorCode: 'AMAZON_DETAIL_NOT_RETURNED',
          };
          const item = this.audit(source, current);
          const task = current.tasks[asin];
          task.attempts += 1;
          task.lastCode = item.detailErrorCode || null;
          task.nextRetryAt = null;
          // Keep prior successful raw values on a transport failure; this attempt's
          // quality report remains explicit and is never evidence of a new price.
          if (item.detailStatus !== 'success' && items[asin]?.detailStatus === 'success') {
            items[asin] = { ...items[asin], collectionQuality: item.collectionQuality,
              lastCollectionError: { code: item.detailErrorCode, checkedAt: this.iso() } };
          } else items[asin] = item;
          if (RESTRICTIONS.has(item.detailErrorCode)) restriction = item.detailErrorCode;
          if (item.detailStatus === 'success') {
            // A successful page visit is the collection boundary. Missing page
            // fields remain explicit; only transport failures retry automatically.
            task.status = item.collectionQuality.requiredMissing.length ? 'partial' : 'complete';
          } else if (item.detailRetryable !== false && task.attempts < 3) {
            task.status = 'pending'; task.nextRetryAt = this.after(this.retryMs * 2 ** (task.attempts - 1));
          } else task.status = 'failed';
        }
        current.lastProgressAt = this.iso();
        current.heartbeatAt = this.iso();
        if (restriction) this.restrict(current, restriction);
        else this.advance(current);
      });
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      await this.change(job => {
        job.lastError = String(error.message || error).slice(0, 500);
        job.causeCode = error.code || 'COLLECTION_REQUEST_FAILED';
        for (const asin of activeAsins) {
          const task = job.tasks[asin];
          task.attempts += 1; task.lastCode = job.causeCode;
          task.status = task.attempts >= 3 ? 'failed' : 'pending';
          task.nextRetryAt = this.after(this.retryMs * 2 ** Math.min(task.attempts - 1, 3));
        }
        if (RESTRICTIONS.has(error.code)) this.restrict(job, error.code);
        else if (job.phase === 'discover' && ++job.discoveryAttempts >= 3) {
          job.status = 'needs_attention'; job.message = '店铺枚举连续失败，断点已保存，请检查后继续。';
        } else {
          job.status = 'cooldown'; job.nextRetryAt = this.after(this.retryMs);
          job.message = '检测到请求中断或超时，断点已保存，将自动继续。';
        }
      });
    }
  }

  async withDeadline(operation, controller) {
    let timer;
    let listener;
    try {
      const cancellation = new Promise((_, reject) => {
        listener = () => reject(controller.signal.reason || new Error('Collection interrupted.'));
        controller.signal.addEventListener('abort', listener, { once: true });
        timer = setTimeout(() => controller.abort(collectionError('COLLECTION_TIMEOUT', '采集请求超时，已保存断点。', 504)), this.timeoutMs);
      });
      return await Promise.race([Promise.resolve().then(operation), cancellation]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', listener);
    }
  }

  advance(job) {
    const pending = Object.entries(job.tasks).filter(([asin, task]) => inRetryScope(job, asin) && task.status === 'pending').map(([, task]) => task);
    job.causeCode = null;
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
    if (job.restrictionCount >= 3) {
      job.status = 'needs_attention'; job.nextRetryAt = null;
      job.message = 'Amazon 持续要求访问验证或限制请求，已停止自动请求并保存断点；恢复访问后可继续。';
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
    return { ...item, collectionQuality: auditAmazonProductFields(item, { marketplace: job.marketplace, now: this.iso() }) };
  }

  async settlePreviouslyCollectedTasks(saved) {
    if (!Object.entries(saved?.job?.tasks || {}).some(([asin, task]) => inRetryScope(saved.job, asin) && hasSuccessfulPendingVisit(task, saved.items?.[asin]))) return;
    await this.change((job, items) => {
      for (const [asin, task] of Object.entries(job.tasks)) {
        if (!inRetryScope(job, asin)) continue;
        if (!hasSuccessfulPendingVisit(task, items[asin])) continue;
        items[asin] = this.audit(items[asin], job);
        task.status = items[asin].collectionQuality.requiredMissing.length ? 'partial' : 'complete';
        task.nextRetryAt = null;
      }
      // Migrate the old missing-field retry policy without undoing manual,
      // supplier or access-restriction pauses. Explicit retries have attempts=0.
      if (ACTIVE.has(job.status) && job.phase === 'details' && !RESTRICTIONS.has(job.causeCode)) this.advance(job);
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
    for (const asin of Object.keys(job.tasks)) {
      for (const field of Object.keys(job.quality)) {
        const status = items[asin]?.collectionQuality?.fields?.[field]?.status || 'missing';
        if (Object.hasOwn(job.quality[field], status)) job.quality[field][status] += 1;
      }
    }
  }

  async change(update) {
    const time = this.iso();
    return this.store.updateAmazonCollection(this.runId, value => {
      update(value.job, value.items);
      value.job.updatedAt = time;
      value.job.revision = (value.job.revision || 0) + 1;
      this.summarize(value.job, value.items);
      return value;
    });
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.generation += 1;
    this.controller?.abort(new Error('Local service is restarting.'));
    if (this.work) await this.work;
    if (this.runId && (await this.store.getAmazonCollection(this.runId)).job?.status === 'running') {
      await this.change(job => { job.status = 'queued'; job.message = '服务重启后将继续已保存的断点。'; });
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

function supplierLeaseExpired(job, now) {
  const expiresAt = Date.parse(job.supplierPause?.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function hasSuccessfulPendingVisit(task, item) {
  return task?.status === 'pending' && task.attempts > 0 && !task.lastCode
    && item?.detailStatus === 'success' && !item.lastCollectionError;
}

function inRetryScope(job, asin) {
  return !Array.isArray(job?.targetedRetry?.asins) || job.targetedRetry.asins.includes(asin);
}

function collectionError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}
