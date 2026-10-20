import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { terminateSearchProcess } from './image-search-process.mjs';

let completed = false;
process.once('disconnect', () => {
  if (completed) return process.exit(0);
  // The bridge disappearing is not permission to leave an unbounded upload or
  // browser behind. This PID is this worker, never an unrelated user browser.
  void terminateSearchProcess({ pid: process.pid, exitCode: null, signalCode: null })
    .catch(() => process.exit(1));
});

// No HTTP endpoint or independent retry loop: the bridge owns pacing and
// starts exactly one worker for a reserved queue item.
process.once('message', async message => {
  if (message?.type !== 'search') return process.exit(1);
  let result;
  try {
    const { dispatch } = await import(pathToFileURL(path.join(message.imageFinderRoot, 'dist', 'session', 'dispatch.js')).href);
    const data = await dispatch('image-search', {
      imagePath: message.imagePath, max: message.max, headed: false,
      onProgress: progress => {
        if (process.connected) process.send({ type: 'progress', phase: progress.phase });
      },
    }, { headed: false, profile: 'default' });
    result = { type: 'result', ok: true, data };
  } catch (error) {
    result = { type: 'result', ok: false, error: {
      code: typeof error?.code === 'string' ? error.code : 'SEARCH_FAILED',
      message: String(error?.message || error),
      details: error?.details ?? null, status: error?.status ?? error?.statusCode,
      retryAfter: error?.retryAfter,
    } };
  }
  // dispatch has completed its browser/session cleanup before this exit.
  completed = true;
  if (process.connected) process.send(result, () => process.exit(0));
  else process.exit(1);
});
