import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySearchFailure } from './image-search-rate-policy.mjs';

export const SEARCH_EXECUTION_TIMEOUT_MS = 180_000;
const activeWorkers = new Set();
export const hasActiveSearchProcess = () => activeWorkers.size > 0;
const WORKER = fileURLToPath(new URL('./image-search-worker.mjs', import.meta.url));
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// Terminate only this invocation's owned worker tree. A failed termination must
// never be treated as evidence that the single browser slot is available.
export async function terminateSearchProcess(child, { timeoutMs = 10_000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error('Search worker PID unavailable');
  if (process.platform !== 'win32') {
    process.kill(-child.pid, 'SIGKILL');
    return;
  }
  await new Promise((resolve, reject) => {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { killer.kill(); reject(new Error('Worker-tree termination timed out')); }, timeoutMs);
    killer.once('error', error => { clearTimeout(timer); reject(error); });
    killer.once('exit', code => {
      clearTimeout(timer);
      if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
      else reject(new Error('Worker-tree termination failed'));
    });
  });
}

export function runImageSearchProcess({ imageFinderRoot, imagePath, max, onProgress,
  timeoutMs = SEARCH_EXECUTION_TIMEOUT_MS, stopTimeoutMs = 12_000,
  workerPath = WORKER, spawnImpl = spawn, terminateImpl = terminateSearchProcess } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, stopTimer, result, settled = false, stopping = false, exited = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(stopTimer);
      if (error) reject(error); else resolve(data);
    };
    const timeoutError = () => failure('SEARCH_TIMEOUT', '1688 自动搜图超过 3 分钟未结束，已停止本次执行并保留任务，请检查浏览器后继续。');
    const stopError = () => result?.ok === false && ['manual', 'login'].includes(classifySearchFailure(result.error))
      ? failure(result.error.code, result.error.message, { ...result.error,
        details: { ...result.error.details, workerStopFailed: true } })
      : failure('SEARCH_WORKER_STOP_FAILED', '1688 搜图工作进程无法确认退出，队列已暂停，需检查服务后继续。');
    const complete = () => {
      if (stopping) return; // The terminator must also confirm tree cleanup.
      if (!result) return finish(failure('SEARCH_WORKER_EXITED', '1688 搜图工作进程提前退出，未返回结果。'));
      if (result.ok) finish(null, result.data);
      else finish(failure(result.error?.code || 'SEARCH_FAILED', result.error?.message || '1688 搜图失败', result.error));
    };
    try {
      child = spawnImpl(process.execPath, [workerPath], {
        env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        detached: process.platform !== 'win32', windowsHide: true,
      });
    } catch (error) { finish(error); return; }
    activeWorkers.add(child);
    child.on('error', error => {
      if (!child.pid) activeWorkers.delete(child);
      if (!child.pid) finish(failure('SEARCH_WORKER_START_FAILED', '1688 搜图工作进程启动失败。'));
      // An IPC error after spawn does not prove the owned process has stopped.
    });
    child.once('exit', () => { activeWorkers.delete(child); exited = true; complete(); });
    child.on('message', message => {
      if (settled || stopping || !message || typeof message !== 'object') return;
      if (message.type === 'progress') {
        if (['validating_image', 'uploading_image', 'searching_offers', 'saving_candidates'].includes(message.phase)) {
          try { onProgress?.({ phase: message.phase }); } catch { /* status is best effort */ }
        }
      } else if (message.type === 'result' && typeof message.ok === 'boolean' && !result) result = message;
    });
    timer = setTimeout(async () => {
      stopping = true;
      stopTimer = setTimeout(() => finish(stopError()), stopTimeoutMs);
      try {
        await terminateImpl(child);
        if (!exited && child.exitCode === null && child.signalCode === null) {
          await new Promise(resolveExit => child.once('exit', resolveExit));
        }
        // A completed, classified result survives a teardown timeout. In
        // particular, a challenge must not become an ordinary retryable error.
        if (result?.ok === false) finish(failure(result.error?.code || 'SEARCH_FAILED', result.error?.message || '1688 搜图失败', result.error));
        else if (result?.ok === true) finish(null, result.data);
        else finish(timeoutError());
      } catch { finish(stopError()); }
    }, timeoutMs);
    try {
      child.send({ type: 'search', imageFinderRoot, imagePath, max }, () => {});
    } catch { /* Wait for exit/deadline; do not release a potentially live worker. */ }
  });
}
