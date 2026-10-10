import { hasQualifyingAmazonMonthlySales } from './amazon-sales-policy.mjs';

const ACTIVE = new Set(['queued', 'running', 'cooldown']);
const TERMINAL = new Set(['complete', 'fallback_estimate', 'manual_cost', 'similarity_insufficient', 'insufficient', 'similarity_unverified']);
const TRANSIENT = new Set(['not_started', 'pending', 'missing_inputs', 'not_logged_in', 'session_expired', 'queue_waiting', 'searching']);
const MANUAL_REQUIRED = new Set(['RISK_CONTROL', 'RISK_VERIFICATION_REQUIRED', 'LOGIN_REQUIRED', 'NOT_LOGGED_IN', 'VERIFICATION_FAILED', 'AUTH_REQUIRED']);
const QUEUE_WAIT = new Set(['RATE_LIMITED', 'QUEUE_BUSY', 'TASK_QUEUED', 'TASK_RUNNING', 'AUTH_CHECKING', 'PROCUREMENT_TASK_PENDING']);
const clone = value => structuredClone(value);
const number = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const protectedProduct = product => !product || product.analysisHandoff?.owner === 'procurement'
  || product.reviewStatus === 'rejected' || product.manualPurchaseCost === true
  || product.costSource === 'manual' || String(product.supplierSource || '').startsWith('manual');
const taskIdOf = value => {
  const id = typeof value === 'string' ? value : value?.taskId || value?.id;
  return /^(?:task_[A-Za-z0-9][A-Za-z0-9_-]{0,122}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(id || '') ? id : null;
};
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

// The store serializes updateSnapshot mutations against the latest saved
// snapshot. search owns transport/task reuse; applyResult owns quote policy and
// the shared profit formula. No business request is made by this module itself.
export class SupplierPipelineRunner {
  constructor({ store, search, applyResult, getRuntime, canRun = () => true, onBusy = () => {},
    now = () => Date.now(), intervalMs = 5000, retryMs = 90_000, maxAttempts = 3 } = {}) {
    Object.assign(this, { store, search, applyResult, getRuntime, canRun, onBusy, now, intervalMs, retryMs });
    this.maxAttempts = Math.max(1, Math.min(3, Number(maxAttempts) || 3));
    this.runId = null;
    this.cachedStatus = null;
    this.work = null;
    this.controller = null;
    this.timer = null;
    this.closed = false;
    this.controls = Promise.resolve();
  }

  async initialize({ timer = true } = {}) {
    const runId = await this.store.getActiveRunId();
    const snapshot = runId ? await this.store.readSnapshot(runId) : null;
    if (snapshot?.runState?.supplier1688Pipeline?.owner === 'server') {
      this.runId = runId;
      await this.change((_snapshot, pipeline) => {
        if (pipeline.status === 'running') {
          pipeline.status = 'queued';
          pipeline.restartCount = (pipeline.restartCount || 0) + 1;
          const task = pipeline.tasks?.[pipeline.activeProductId];
          if (task) task.status = 'pending';
          pipeline.activeProductId = null;
        }
      });
    }
    if (timer && !this.timer) {
      this.timer = setInterval(() => void this.tick().catch(error => this.log(error)), this.intervalMs);
      this.timer.unref?.();
    }
    return this.status();
  }

  control(operation) {
    const next = this.controls.then(operation, operation);
    this.controls = next.catch(() => {});
    return next;
  }

  async start(runId, { resume = false } = {}) {
    return this.control(async () => {
      if (this.closed) throw failure('SUPPLIER_CLOSED', '1688 后台服务正在关闭。');
      const active = await this.status();
      if (this.work || (active && active.runId !== runId && active.status !== 'complete')) {
        if (active?.runId === runId && ACTIVE.has(active.status)) return active;
        throw failure('SUPPLIER_BUSY', '已有 1688 后台任务，请先处理当前任务。');
      }
      const snapshot = await this.store.readSnapshot(runId);
      const saved = snapshot?.runState?.supplier1688Pipeline;
      if (!saved?.productIds?.length || !Array.isArray(saved.productIds)) {
        throw failure('SUPPLIER_SCOPE_REQUIRED', '请先确认需要匹配的商品范围。', 422);
      }
      if (resume && saved.owner === 'server' && saved.status === 'complete' && !this.pending(snapshot).length) {
        this.updateCounts(snapshot);
        const excluded = Number(saved.excludedMonthlySalesCount || 0);
        throw failure('SUPPLIER_NO_PENDING_PRODUCTS', excluded
          ? `当前没有待匹配商品；${excluded} 个商品因缺少 Amazon 50+ 月购买量标识已跳过。请刷新页面更新列表，已有结果保留。`
          : '当前批次已处理完成，没有待匹配商品。请刷新页面更新列表，已有结果保留。');
      }
      if (saved.owner === 'server' && (ACTIVE.has(saved.status) || !resume)) {
        this.runId = runId;
        await this.store.setActiveRunId(runId);
        return this.status();
      }
      this.runId = runId;
      await this.change((_snapshot, pipeline) => {
        pipeline.owner = 'server';
        pipeline.enabled = true;
        pipeline.status = 'queued';
        pipeline.causeCode = null;
        pipeline.lastReason = null;
        pipeline.nextRetryAt = null;
        pipeline.completedAt = null;
        pipeline.activeProductId = null;
        pipeline.startedAt ||= this.iso();
        pipeline.tasks ||= {};
        // An explicit resume releases attention/manual pauses, never expands
        // the saved cohort or silently resets exhausted ordinary failures.
      }, { claim: true });
      await this.store.setActiveRunId(runId);
      return this.status();
    });
  }

  // Append to the durable cohort without starting or releasing paused work.
  async append(runId, productIds) {
    return this.control(async () => {
      if (this.closed) throw failure('SUPPLIER_CLOSED', '1688 后台服务正在关闭。');
      if (!Array.isArray(productIds) || !productIds.length || productIds.length > 10_000
        || productIds.some(id => typeof id !== 'string' || !id.trim() || /[\u0000-\u001f]/.test(id))) {
        throw failure('SUPPLIER_SCOPE_INVALID', '请选择 1 至 10000 个有效商品。', 422);
      }
      const ids = [...new Set(productIds.map(id => id.trim()))];
      const activeRunIds = [...new Set([this.runId, await this.store.getActiveRunId()].filter(Boolean))];
      if (this.work) throw failure('SUPPLIER_BUSY', '已有 1688 后台任务，请先处理当前任务。');
      for (const activeRunId of activeRunIds) {
        if (activeRunId === runId) continue;
        const active = await this.store.readSnapshot(activeRunId);
        if (active?.runState?.supplier1688Pipeline?.status !== 'complete') {
          throw failure('SUPPLIER_BUSY', '已有 1688 后台任务，请先处理当前任务。');
        }
      }
      const inspect = snapshot => {
        const pipeline = snapshot?.runState?.supplier1688Pipeline;
        if (!pipeline || !Array.isArray(pipeline.productIds)) {
          throw failure('SUPPLIER_SCOPE_REQUIRED', '请先确认需要匹配的商品范围。', 422);
        }
        if (ACTIVE.has(pipeline.status) || pipeline.activeProductId || this.work) {
          throw failure('SUPPLIER_BUSY', '1688 匹配仍在执行，请等待完成或暂停后再追加商品。');
        }
        const products = new Map((snapshot.products || []).map(item => [item.id, item]));
        if (ids.some(id => !products.has(id))) {
          throw failure('SUPPLIER_SCOPE_INVALID', '追加商品必须全部属于当前任务。', 422);
        }
        const cohort = new Set(pipeline.productIds);
        const additions = ids.filter(id => {
          const item = products.get(id);
          return !cohort.has(id) && hasQualifyingAmazonMonthlySales(item) && !protectedProduct(item) && !TERMINAL.has(item.supplierSearchStatus)
            && !['complete', 'failed', 'skipped'].includes(pipeline.tasks?.[id]?.status)
            && typeof item.imageUrl === 'string' && /^https?:\/\//i.test(item.imageUrl);
        });
        return { pipeline, cohort, additions };
      };
      const initial = inspect(await this.store.readSnapshot(runId));
      if (!initial.additions.length) return { ...clone(initial.pipeline), runId };
      const saved = await this.store.updateSnapshot(runId, snapshot => {
        const { pipeline, cohort, additions } = inspect(snapshot);
        if (!additions.length) return snapshot;
        pipeline.productIds = [...cohort, ...additions];
        pipeline.selectedCount = pipeline.productIds.length;
        this.updateCounts(snapshot);
        pipeline.revision = (Number(pipeline.revision) || 0) + 1;
        pipeline.updatedAt = this.iso();
        if (pipeline.status === 'complete' && pipeline.remaining) {
          pipeline.status = 'paused';
          pipeline.enabled = false;
          pipeline.lastReason = 'selection_saved';
          pipeline.causeCode = null;
          pipeline.completedAt = null;
          pipeline.nextRetryAt = null;
        }
        return snapshot;
      });
      const status = { ...clone(saved.runState.supplier1688Pipeline), runId };
      if (this.runId === runId && status.owner === 'server') this.cachedStatus = status;
      return status;
    });
  }
  async pause(runId = this.runId) {
    return this.control(async () => {
      if (runId !== this.runId) throw failure('SUPPLIER_NOT_ACTIVE', '该批次不是当前后台匹配任务。', 404);
      await this.change((_snapshot, pipeline) => {
        pipeline.enabled = false;
        pipeline.status = 'paused';
        pipeline.causeCode = 'USER_PAUSED';
        pipeline.lastReason = 'user_paused';
        pipeline.nextRetryAt = null;
      });
      // Do not abort the in-flight search: preserve the result it returns,
      // while the durable pause prevents the next product from starting.
      return this.status();
    });
  }

  async status() {
    if (!this.runId) return null;
    const snapshot = await this.store.readSnapshot(this.runId);
    const pipeline = snapshot?.runState?.supplier1688Pipeline;
    this.cachedStatus = pipeline?.owner === 'server' ? { ...clone(pipeline), runId: this.runId } : null;
    return this.cachedStatus;
  }

  // Remove the saved batch checkpoint for a run so the page can replace it
  // with a new filtered selection. Quotes and profit on matched products are
  // kept; only transient "waiting" states revert to not_started. Without this
  // the server-owned revision would reject every replacement save with
  // STALE_SUPPLIER_SNAPSHOT.
  async discard(runId = null) {
    return this.control(async () => {
      if (this.closed) throw failure('SUPPLIER_CLOSED', '1688 后台服务正在关闭。');
      const targetRunId = runId || this.runId || await this.store.getActiveRunId();
      if (!targetRunId) return null;
      if (this.runId === targetRunId && this.work) {
        this.controller?.abort(failure('SUPPLIER_BATCH_DISCARDED', '匹配批次已改用新的筛选。'));
        await this.work.catch(() => {});
      }
      await this.store.updateSnapshot(targetRunId, snapshot => {
        const pipeline = snapshot?.runState?.supplier1688Pipeline;
        if (pipeline) {
          const cohort = new Set(pipeline.productIds || []);
          for (const product of snapshot.products || []) {
            if (!cohort.has(product.id)) continue;
            if (TRANSIENT.has(String(product.supplierSearchStatus || ''))) {
              product.supplierSearchStatus = 'not_started';
              product.supplierSearchError = null;
              product.supplierSearchErrorCode = null;
            }
          }
          delete snapshot.runState.supplier1688Pipeline;
        }
        return snapshot;
      });
      if (this.runId === targetRunId) { this.runId = null; this.cachedStatus = null; }
      if (await this.store.getActiveRunId() === targetRunId) await this.store.setActiveRunId(null);
      return null;
    });
  }

  isRunnable() {
    const pipeline = this.cachedStatus;
    return !this.closed && pipeline?.enabled !== false && ACTIVE.has(pipeline?.status)
      && (!pipeline.nextRetryAt || Date.parse(pipeline.nextRetryAt) <= this.now());
  }

  tick() {
    if (this.closed || this.work) return this.work || Promise.resolve();
    this.work = this.perform().finally(() => { this.work = null; });
    return this.work;
  }

  async perform() {
    const pipeline = await this.status();
    if (!this.isRunnable() || !pipeline || !(await this.canRun()) || this.closed) return;
    const snapshot = await this.store.readSnapshot(this.runId);
    let candidates = this.pending(snapshot);
    if (!candidates.length) {
      await this.change(() => {});
      return;
    }
    candidates = candidates.filter(product => !this.future(snapshot.runState.supplier1688Pipeline.tasks?.[product.id]?.nextRetryAt));
    if (!candidates.length) {
      await this.change((_snapshot, current) => this.setNext(current, 'cooldown', 'RETRY_DELAY', this.earliestRetry(_snapshot)));
      return;
    }
    const candidate = candidates[0];
    let runtime;
    try { runtime = await this.getRuntime(); }
    catch (error) {
      await this.deferRuntime(error.code || 'RUNTIME_UNAVAILABLE', error.details?.nextAllowedAt);
      return;
    }
    const runtimeBlock = this.runtimeBlock(runtime, candidate, snapshot);
    if (runtimeBlock) { await this.deferRuntime(runtimeBlock.code, runtimeBlock.until); return; }
    if (this.closed || !(await this.canRun())) return;
    let selected = null;
    let searchSnapshot = null;
    await this.change((latest, current) => {
      if (!ACTIVE.has(current.status) || current.enabled === false || this.closed) return;
      const product = this.pending(latest).find(item => item.id === candidate.id);
      if (!product || this.future(current.tasks?.[product.id]?.nextRetryAt)) return;
      const task = current.tasks[product.id] ||= { attempts: 0, failureCount: 0 };
      const taskId = taskIdOf(product.supplierProcurementTaskId) || taskIdOf(task.taskId);
      if (taskId) product.supplierProcurementTaskId = taskId;
      task.taskId = taskId;
      task.attempts = (task.attempts || 0) + 1;
      task.status = 'running';
      task.startedAt = this.iso();
      task.nextRetryAt = null;
      product.supplierSearchStatus = 'searching';
      current.status = 'running';
      current.activeProductId = product.id;
      current.nextRetryAt = null;
      selected = clone(product);
      searchSnapshot = clone(latest);
    });
    if (!selected) return;
    const controller = new AbortController();
    this.controller = controller;
    this.onBusy(true);
    try {
      if (this.closed) {
        controller.abort(failure('SUPPLIER_CLOSED', '1688 后台服务正在关闭。'));
        throw controller.signal.reason;
      }
      const result = await this.search(selected, searchSnapshot, {
        signal: controller.signal,
        onTask: async value => {
          const taskId = taskIdOf(value);
          if (!taskId) throw failure('SUPPLIER_TASK_ID_INVALID', '1688 返回了无效的任务编号。', 502);
          await this.change((latest, current) => {
            const task = current.tasks[selected.id] ||= {};
            if (task.taskId && task.taskId !== taskId) throw failure('SUPPLIER_TASK_CHANGED', '本次匹配任务编号发生变化，已停止。');
            task.taskId = taskId;
            const product = latest.products.find(item => item.id === selected.id);
            if (!protectedProduct(product)) product.supplierProcurementTaskId = taskId;
          });
        },
      });
      await this.change(async (latest, current) => {
        const task = current.tasks[selected.id];
        const index = latest.products.findIndex(item => item.id === selected.id);
        const product = latest.products[index];
        if (!protectedProduct(product) && current.productIds.includes(selected.id)) {
          const applied = await this.applyResult(product, result, latest);
          if (applied) latest.products[index] = applied;
          if (task.taskId) latest.products[index].supplierProcurementTaskId = task.taskId;
          task.status = 'complete';
        } else task.status = 'skipped';
        task.completedAt = this.iso();
        task.nextRetryAt = null;
        current.activeProductId = null;
        if (current.enabled !== false && current.status !== 'paused') this.setNext(current, 'queued', null);
      });
    } catch (error) {
      await this.finishError(selected.id, error, controller.signal.aborted);
    } finally {
      this.controller = null;
      this.onBusy(false);
    }
  }

  async finishError(productId, error, aborted) {
    await this.change((snapshot, pipeline) => {
      const task = pipeline.tasks[productId] ||= { attempts: 0, failureCount: 0 };
      task.taskId ||= taskIdOf(error.details?.taskId);
      const product = snapshot.products.find(item => item.id === productId);
      if (task.taskId && !protectedProduct(product)) product.supplierProcurementTaskId = task.taskId;
      pipeline.activeProductId = null;
      if (aborted) {
        task.status = 'pending';
        if (!protectedProduct(product)) product.supplierSearchStatus = 'queue_waiting';
        if (pipeline.enabled !== false) this.setNext(pipeline, 'queued', 'SERVICE_RESTART');
        return;
      }
      const code = String(error.code || 'SUPPLIER_SEARCH_FAILED');
      const manual = MANUAL_REQUIRED.has(code);
      const waiting = QUEUE_WAIT.has(code);
      if (!manual && !waiting) task.failureCount = (task.failureCount || 0) + 1;
      const exhausted = !manual && !waiting && (task.failureCount >= this.maxAttempts || error.retryable === false || error.details?.retryable === false);
      task.status = exhausted ? 'failed' : 'pending';
      task.lastCode = code;
      task.nextRetryAt = manual || exhausted ? null : this.validFuture(error.details?.nextAllowedAt) || this.after(this.retryMs * 2 ** Math.max(0, (task.failureCount || 1) - 1));
      if (!protectedProduct(product)) {
        product.supplierSearchStatus = manual ? 'session_expired' : waiting ? 'queue_waiting' : 'failed';
        product.supplierSearchErrorCode = code;
        product.supplierSearchError = String(error.message || '1688 匹配失败').slice(0, 500);
      }
      snapshot.runState.errors ||= [];
      snapshot.runState.errors.push({ stage: '1688_image_search', code, message: String(error.message || code).slice(0, 500),
        productId, asin: product?.asin || null, taskId: task.taskId || null, recovered: false, createdAt: this.iso() });
      if (pipeline.enabled === false || pipeline.status === 'paused') return;
      if (manual) {
        pipeline.enabled = false;
        this.setNext(pipeline, 'needs_attention', code);
      } else this.setNext(pipeline, 'cooldown', code, task.nextRetryAt || this.after(this.retryMs));
    });
  }

  runtimeBlock(runtime, product, snapshot) {
    const queue = runtime?.queue || {};
    const policy = queue.ratePolicy || {};
    if (policy.manualResumeRequired || Number(queue.riskBlocked) > 0 || (policy.pausedReason && policy.pausedReason !== 'RATE_LIMITED')) return { code: 'RISK_VERIFICATION_REQUIRED' };
    if (runtime?.auth?.ready !== true) {
      const reason = runtime?.auth?.reason;
      return { code: ['checking', 'waiting_login'].includes(reason) ? 'AUTH_CHECKING' : reason === 'risk_control' ? 'RISK_CONTROL' : 'LOGIN_REQUIRED' };
    }
    if (policy.pausedReason === 'RATE_LIMITED' || this.future(policy.nextAllowedAt)) return { code: 'RATE_LIMITED', until: policy.nextAllowedAt };
    const existingTask = taskIdOf(product.supplierProcurementTaskId) || taskIdOf(snapshot.runState.supplier1688Pipeline.tasks?.[product.id]?.taskId);
    if (!existingTask && Number(queue.running || 0) + Number(queue.queued || 0) > 0) return { code: 'QUEUE_BUSY' };
    return null;
  }

  async deferRuntime(code, until) {
    await this.change((_snapshot, pipeline) => {
      if (!ACTIVE.has(pipeline.status) || pipeline.enabled === false) return;
      if (MANUAL_REQUIRED.has(code)) {
        pipeline.enabled = false;
        this.setNext(pipeline, 'needs_attention', code);
      } else this.setNext(pipeline, 'cooldown', code, this.validFuture(until) || this.after(this.retryMs));
    });
  }

  pending(snapshot) {
    const pipeline = snapshot?.runState?.supplier1688Pipeline;
    const ids = new Set(pipeline?.productIds || []);
    return (snapshot?.products || []).filter(product => {
      const task = pipeline?.tasks?.[product.id];
      return ids.has(product.id) && hasQualifyingAmazonMonthlySales(product) && !protectedProduct(product) && !TERMINAL.has(product.supplierSearchStatus)
        && !['complete', 'failed', 'skipped'].includes(task?.status)
        && typeof product.imageUrl === 'string' && /^https?:\/\//i.test(product.imageUrl);
    }).sort((a, b) => {
      const priority = product => taskIdOf(product.supplierProcurementTaskId) || taskIdOf(pipeline.tasks?.[product.id]?.taskId) ? 0
        : number(product.salePrice ?? product.currentPrice) > 0 && number(product.productWeight ?? product.billingWeight ?? product.profitInputs?.actualWeightKg) > 0 ? 1 : 2;
      return priority(a) - priority(b);
    });
  }

  updateCounts(snapshot) {
    const pipeline = snapshot.runState.supplier1688Pipeline;
    const ids = new Set(pipeline.productIds || []);
    // Historical finished results stay counted and untouched. Only unfinished
    // products excluded by the sales rule are removed from the processed total.
    pipeline.excludedMonthlySalesCount = (snapshot.products || []).filter(product => ids.has(product.id)
      && !hasQualifyingAmazonMonthlySales(product) && !TERMINAL.has(product.supplierSearchStatus)
      && !['complete', 'skipped'].includes(pipeline.tasks?.[product.id]?.status)).length;
    pipeline.remaining = this.pending(snapshot).length;
    pipeline.matchableCount = Math.max(0, ids.size - pipeline.excludedMonthlySalesCount);
    pipeline.processed = Math.max(0, pipeline.matchableCount - pipeline.remaining);
    pipeline.failedCount = Object.values(pipeline.tasks || {}).filter(task => task.status === 'failed').length;
  }

  async change(operation, { claim = false } = {}) {
    if (!this.runId) return;
    const runId = this.runId;
    await this.store.updateSnapshot(runId, async snapshot => {
      const pipeline = snapshot?.runState?.supplier1688Pipeline;
      if (!pipeline || (!claim && pipeline.owner !== 'server')) throw failure('SUPPLIER_OWNERSHIP_CHANGED', '1688 后台任务归属已变化。');
      pipeline.tasks ||= {};
      await operation(snapshot, pipeline);
      pipeline.revision = (pipeline.revision || 0) + 1;
      pipeline.updatedAt = this.iso();
      this.updateCounts(snapshot);
      if (!pipeline.remaining && pipeline.status !== 'paused' && pipeline.status !== 'needs_attention') {
        pipeline.status = 'complete'; pipeline.enabled = false; pipeline.completedAt = this.iso(); pipeline.nextRetryAt = null;
        if (pipeline.excludedMonthlySalesCount) pipeline.lastReason = 'monthly_sales_filtered';
      }
      this.cachedStatus = { ...clone(pipeline), runId };
      return snapshot;
    });
  }

  earliestRetry(snapshot) {
    return this.pending(snapshot).map(product => snapshot.runState.supplier1688Pipeline.tasks[product.id]?.nextRetryAt).filter(Boolean).sort()[0] || this.after(this.retryMs);
  }
  setNext(pipeline, status, code, nextRetryAt = null) {
    pipeline.status = status; pipeline.causeCode = code; pipeline.lastReason = code; pipeline.nextRetryAt = nextRetryAt;
  }
  future(value) { return Number.isFinite(Date.parse(value || '')) && Date.parse(value) > this.now(); }
  validFuture(value) { return this.future(value) ? new Date(value).toISOString() : null; }
  iso() { return new Date(this.now()).toISOString(); }
  after(ms) { return new Date(this.now() + ms).toISOString(); }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort(failure('SUPPLIER_CLOSED', '1688 后台服务正在关闭。'));
    if (this.work) await this.work;
  }
  log(error) { process.stderr.write(`1688 supplier pipeline: ${error.code || 'SUPPLIER_RUNNER_ERROR'}\n`); }
}
