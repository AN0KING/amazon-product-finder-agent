import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { CliError } from '../1688-dependencies/1688-image-finder/dist/io/errors.js';

// Exercise the real launch -> ownership -> navigation -> Win32 proof -> cleanup
// chain. All OS/browser boundaries are synthetic; no installed browser is opened.
const sources = [['bundled', new URL('../1688-dependencies/1688-image-finder/dist/session/native-edge.js', import.meta.url)]];
if (process.platform === 'win32') {
  const runtime = 'D:/deliverables/1688-image-finder/dist/session/native-edge.js';
  if (await readFile(runtime, 'utf8').then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) sources.push(['runtime', runtime]);
}
const token = '12345678-1234-1234-1234-123456789abc';
const profileDir = 'C:/synthetic-private-profile';
const loginUrl = 'https://login.1688.com/member/signin.htm?tbpm=1';
const privateText = 'private-account session-token C:/synthetic-private-profile';
const validProof = { ok: true, pid: 1234, handle: '100', visible: true, left: 48, top: 48, width: 1280, height: 840 };

class FakeClock {
  now = 0;
  sequence = 0;
  timers = new Map();
  setTimeout = (callback, milliseconds) => {
    const timer = { id: ++this.sequence, at: this.now + milliseconds, callback, unref() {} };
    this.timers.set(timer.id, timer);
    return timer;
  };
  clearTimeout = timer => { this.timers.delete(timer?.id); };
  async runUntil(promise) {
    let settled = false, value, failure;
    promise.then(result => { settled = true; value = result; }, error => { settled = true; failure = error; });
    for (let step = 0; step < 1000; step += 1) {
      // Drain async filesystem/profile checks before advancing a future timer.
      for (let turn = 0; turn < 64; turn += 1) await Promise.resolve();
      if (settled) { if (failure) throw failure; return value; }
      const next = [...this.timers.values()].sort((left, right) => left.at - right.at || left.id - right.id)[0];
      assert.ok(next, 'The lifecycle must have a pending timer or an observable result.');
      this.timers.delete(next.id);
      this.now = next.at;
      next.callback();
    }
    throw new Error('Virtual lifecycle exceeded its bounded timer count.');
  }
}

function harness(source, scenario = {}) {
  const calls = [], timeouts = [];
  const clock = scenario.lifecycle ? new FakeClock() : null;
  const schedule = clock?.setTimeout || setTimeout;
  const cancel = clock?.clearTimeout || clearTimeout;
  class ClockDate extends Date { static now() { return clock.now; } }
  let closed = false;
  const browser = { isConnected: () => true, newBrowserCDPSession: async () => ({
    send: async command => command === 'Browser.getBrowserCommandLine'
      ? { arguments: ['msedge.exe', `--user-data-dir=${profileDir}`, `--bb1688-launch-token=${scenario.unowned ? 'different' : token}`] }
      : { processInfo: [{ type: 'browser', id: 1234 }] }, detach: async () => {},
  }) };
  const browserContext = {
    browser: () => browser,
    pages: () => [{ url: () => loginUrl, bringToFront: async () => calls.push('focus-visible') }],
    newCDPSession: async () => ({ send: async command => command === 'Browser.getWindowForTarget' ? { windowId: 1 }
      : command === 'Browser.getWindowBounds' ? { bounds: { windowState: 'normal', width: 1280, height: 840 } } : {}, detach: async () => {} }),
    close: async () => { closed = true; calls.push('context.close'); },
  };
  const sandbox = { path, Buffer, URL, Date: clock ? ClockDate : Date, clearTimeout: cancel, CliError,
    setTimeout(callback, milliseconds) {
      timeouts.push(milliseconds);
      return schedule(callback, scenario.timeout && [10_000, 30_000].includes(milliseconds) ? 0 : milliseconds);
    },
    crypto: { randomUUID: () => token }, fs: { existsSync: () => true },
    fsp: { mkdir: async () => {}, lstat: async () => { throw Object.assign(new Error('synthetic absent marker'), { code: 'ENOENT' }); } },
    profilePath: () => profileDir, edgeCacheDir: () => 'C:/synthetic-cache',
    acquireLock: async () => { calls.push('lock'); return async () => { calls.push('release-lock'); }; },
    process: { platform: 'win32', env: { ProgramFiles: 'C:/Program Files' } },
    chromium: { launchPersistentContext: async (_profile, options) => {
      calls.push('visible-browser-launched');
      assert.equal(options.headless, false);
      assert.equal(options.channel, 'msedge');
      if (clock) return new Promise((resolve, reject) => {
        // Respect the actual timeout handed to Playwright by the production
        // lifecycle, including its cleanup when the process never connects.
        const connected = schedule(() => { cancel(expired); calls.push('browser-connected'); resolve(browserContext); }, scenario.launchDelayMs ?? 1000);
        const expired = schedule(() => {
          cancel(connected); closed = true; calls.push('playwright-startup-cleanup');
          reject(Object.assign(new Error('synthetic startup deadline'), { name: 'TimeoutError' }));
        }, options.timeout);
      });
      return browserContext;
    } },
    spawn: (_executable, _args, options) => {
      calls.push('proof-helper');
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, false);
      if (scenario.spawnThrow) throw new Error(privateText);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { calls.push('helper.kill'); child.emit('close', null); };
      const report = () => {
        if (scenario.timeout) return;
        if (scenario.processError) { child.emit('error', new Error(privateText)); return; }
        if (scenario.stderr) child.stderr.emit('data', scenario.stderr);
        if (scenario.stdout !== undefined) child.stdout.emit('data', scenario.stdout);
        else child.stdout.emit('data', JSON.stringify(validProof));
        child.emit('close', scenario.exitCode ?? 0);
      };
      if (clock) schedule(report, scenario.proofDelayMs ?? 1000);
      else queueMicrotask(report);
      return child;
    },
  };
  vm.createContext(sandbox);
  const implementation = source.replace(/^import .*?;\r?\n/gm, '').replace(/^export /gm, '');
  const launch = vm.runInContext(`${implementation}\nopenDirectVisibleEdge`, sandbox, { filename: 'native-edge.js' });
  return { calls, timeouts, clock, closed: () => closed,
    prove: discovery => vm.runInContext('proveOwnedVisibleEdgeWindow', sandbox)([1234], discovery),
    lifecycle(options = {}) {
      let interactive, releaseInteraction;
      const ready = new Promise(resolve => { interactive = resolve; });
      const userFinished = new Promise(resolve => { releaseInteraction = resolve; });
      const operation = vm.runInContext('withNativeVisibleEdge', sandbox)({ profile: 'default', launchUrl: loginUrl, ...options }, async context => {
        calls.push('interaction-ready');
        assert.equal(context, browserContext);
        interactive('ready');
        await userFinished;
        return 'identity';
      }, async identity => { calls.push('closed-profile-verification'); return identity; });
      return { ready: Promise.race([ready, operation]), operation, releaseInteraction };
    },
    launch: () => launch({ profileDir, cacheDir: 'C:/synthetic-cache', launchUrl: loginUrl, startupTimeoutMs: 20_000 }) };
}

for (const [label, file] of sources) {
  const source = await readFile(file, 'utf8');
  const failures = [
    ['spawn failure', { spawnThrow: true }, 'EDGE_WINDOW_CHECK_FAILED', 'spawn_failed'],
    ['process failure', { processError: true }, 'EDGE_WINDOW_CHECK_FAILED', 'process_error'],
    ['compilation failure', { stderr: `Add-Type : Compilation errors occurred. ${privateText}`, stdout: '', exitCode: 1 }, 'EDGE_WINDOW_CHECK_FAILED', 'compilation_failed'],
    ['execution failure', { stderr: privateText, stdout: '', exitCode: 1 }, 'EDGE_WINDOW_CHECK_FAILED', 'execution_failed'],
    ['overflow', { stdout: privateText.repeat(4000) }, 'EDGE_WINDOW_CHECK_FAILED', 'output_overflow'],
    ['invalid proof', { stdout: JSON.stringify({ ...validProof, pid: 5678 }) }, 'EDGE_WINDOW_CHECK_FAILED', 'invalid_proof'],
    ['unknown reported reason', { stdout: JSON.stringify({ ok: false, reason: privateText }), exitCode: 4 }, 'EDGE_WINDOW_CHECK_FAILED', 'execution_failed'],
    ['wrong desktop', { stdout: JSON.stringify({ ok: false, reason: 'wrong_desktop' }), exitCode: 3 }, 'EDGE_WINDOW_WRONG_DESKTOP', 'wrong_desktop'],
    ['no window', { stdout: JSON.stringify({ ok: false }), exitCode: 4 }, 'EDGE_WINDOW_NOT_VISIBLE', 'no_window'],
    ['proof timeout', { timeout: true }, 'EDGE_WINDOW_PROOF_TIMEOUT', 'timeout'],
  ];
  for (const [name, scenario, code, reason] of failures) test(`${label}: ${name} keeps its safe cause classification and closes only the owned context`, async () => {
    const fixture = harness(source, scenario);
    await assert.rejects(fixture.launch(), error => {
      assert.equal(error.code, code);
      assert.equal(error.details.stage, 'window_proof');
      assert.equal(error.details.reason, reason);
      assert.equal(typeof error.cause?.message, 'string');
      assert.ok(Number.isFinite(error.details.elapsedMs) && error.details.elapsedMs >= 0);
      assert.equal(error.details.timeoutMs, 30_000);
      const publicPayload = JSON.stringify({ code: error.code, message: error.message, details: error.details });
      assert.doesNotMatch(publicPayload, /private-account|session-token|synthetic-private-profile|12345678|Add-Type/);
      return true;
    });
    assert.equal(fixture.closed(), true);
    assert.equal(fixture.calls.filter(value => value === 'context.close').length, 1);
    assert.equal(fixture.calls.filter(value => value === 'proof-helper').length, 1, 'No automatic retry.');
    assert.deepEqual(fixture.calls.slice(0, 3), ['visible-browser-launched', 'focus-visible', 'proof-helper']);
    if (scenario.timeout) assert.ok(fixture.timeouts.includes(30_000), 'Keep a finite helper deadline including startup and compilation.');
  });
  test(`${label}: valid owned proof returns the visible browser without closing it`, async () => {
    const fixture = harness(source);
    assert.ok(await fixture.launch());
    assert.equal(fixture.closed(), false);
    assert.deepEqual(fixture.calls, ['visible-browser-launched', 'focus-visible', 'proof-helper']);
  });
  test(`${label}: ownership mismatch fails before navigation or native proof`, async () => {
    const fixture = harness(source, { unowned: true });
    await assert.rejects(fixture.launch(), { code: 'EDGE_OWNERSHIP_UNPROVEN' });
    assert.deepEqual(fixture.calls, ['visible-browser-launched', 'context.close']);
  });
  for (const [launchDelayMs, proofDelayMs] of [[25_000, 1000], [1000, 12_000], [25_000, 12_000]]) {
    test(`${label}: lifecycle permits connection at ${launchDelayMs}ms and owned proof after ${proofDelayMs}ms before user interaction`, async () => {
      const fixture = harness(source, { lifecycle: true, launchDelayMs, proofDelayMs });
      const active = fixture.lifecycle();
      assert.equal(await fixture.clock.runUntil(active.ready), 'ready');
      assert.equal(fixture.closed(), false, 'Keep the proved window open while the user has not completed interaction.');
      assert.ok(fixture.clock.now >= launchDelayMs + proofDelayMs);
      assert.equal(fixture.calls.filter(call => call === 'proof-helper').length, 1);
      active.releaseInteraction();
      assert.equal(await fixture.clock.runUntil(active.operation), 'identity');
      assert.equal(fixture.closed(), true);
      assert.deepEqual(fixture.calls.slice(-3), ['context.close', 'closed-profile-verification', 'release-lock']);
    });
  }
  for (const [name, scenario, code] of [
    ['no window', { proofDelayMs: 6000, stdout: '{"ok":false}', exitCode: 4 }, 'EDGE_WINDOW_NOT_VISIBLE'],
    ['late invalid proof', { proofDelayMs: 12_000, stdout: JSON.stringify({ ...validProof, pid: 5678 }) }, 'EDGE_WINDOW_CHECK_FAILED'],
    ['startup exceeds the finite deadline', { launchDelayMs: 70_000 }, 'EDGE_STARTUP_TIMEOUT'],
    ['proof exceeds the finite deadline', { proofDelayMs: 31_000 }, 'EDGE_WINDOW_PROOF_TIMEOUT'],
  ]) test(`${label}: lifecycle ${name} still closes the failed window without retries`, async () => {
    const fixture = harness(source, { lifecycle: true, ...scenario });
    const active = fixture.lifecycle();
    await assert.rejects(fixture.clock.runUntil(active.ready), { code });
    assert.equal(fixture.closed(), true);
    assert.ok(!fixture.calls.includes('interaction-ready'));
    assert.equal(fixture.calls.filter(call => call === 'visible-browser-launched').length, 1);
    assert.equal(fixture.calls.at(-1), 'release-lock');
  });
  test(`${label}: manual discovery gives its search window the same separate helper startup budget`, async () => {
    const fixture = harness(source, { lifecycle: true, proofDelayMs: 24_000 });
    const proof = fixture.prove({ launchToken: token, profileDir, executable: 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', launchStartedAt: 0, startupTimeoutMs: 20_000 });
    assert.equal((await fixture.clock.runUntil(proof)).pid, 1234);
  });
}
