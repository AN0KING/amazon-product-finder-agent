import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { buildDirectVisibleEdgeArgs, classifyNativeEdgeLaunchFailure } from '../dist/session/native-edge.js';

const loginUrl = 'https://login.1688.com/member/signin.htm?tbpm=1';
const token = '12345678-1234-1234-1234-123456789abc';
const profileDir = path.resolve('test/synthetic-profile');
const cacheDir = path.resolve('test/synthetic-cache');
const source = await readFile(new URL('../dist/session/native-edge.js', import.meta.url), 'utf8');
const from = source.indexOf('async function openDirectVisibleEdge(input)');
const to = source.indexOf('async function proveDirectVisibleEdge(', from);
assert.ok(from >= 0 && to > from);
const launchSource = source.slice(from, to);

function harness({ launchError, ownershipError, visibilityError } = {}) {
  const calls = [];
  const browserContext = {};
  const owned = new WeakMap();
  const context = vm.createContext({
    resolveMicrosoftEdgeExecutable: () => 'C:/mock/msedge.exe',
    crypto: { randomUUID: () => token },
    buildDirectVisibleEdgeArgs,
    classifyNativeEdgeLaunchFailure,
    chromium: {
      launchPersistentContext: async (profile, options) => {
        calls.push('launch');
        assert.equal(profile, profileDir);
        assert.equal(options.headless, false);
        assert.equal(options.channel, 'msedge');
        // Model the relevant Playwright contract: a persistent launch must
        // finish on its own blank page before an external page can delay load.
        assert.ok(options.args.every(arg => !arg.startsWith('--app=') && !/^https?:/.test(arg)));
        if (launchError) throw launchError;
        return browserContext;
      },
    },
    proveDirectVisibleEdge: async (candidate, profile, launchToken) => {
      calls.push('ownership');
      assert.equal(candidate, browserContext);
      assert.equal(profile, profileDir);
      assert.equal(launchToken, token);
      if (ownershipError) throw ownershipError;
      return [1234];
    },
    directVisibleEdgePids: owned,
    focusVisibleLoginPage: async (candidate, url) => {
      calls.push('navigate');
      assert.equal(candidate, browserContext);
      assert.equal(url, loginUrl);
      assert.deepEqual(owned.get(candidate), [1234]);
    },
    proveOwnedVisibleEdgeWindow: async pids => {
      calls.push('visible');
      assert.deepEqual(pids, [1234]);
      if (visibilityError) throw visibilityError;
    },
    closeDirectVisibleEdge: async candidate => {
      calls.push('close-owned-context');
      assert.equal(candidate, browserContext);
    },
  });
  const launch = vm.runInContext(`${launchSource}\nopenDirectVisibleEdge`, context);
  return { calls, browserContext, launch: () => launch({ profileDir, cacheDir, launchUrl: loginUrl, startupTimeoutMs: 20_000 }) };
}

test('interactive launch starts a regular persistent window without loading the remote login page during startup', () => {
  const args = buildDirectVisibleEdgeArgs(cacheDir, token, loginUrl);
  assert.ok(args.includes('--new-window'));
  assert.ok(args.includes('--enable-automation'));
  assert.ok(args.includes(`--bb1688-launch-token=${token}`));
  assert.ok(args.every(arg => !arg.startsWith('--app=') && !arg.includes('1688.com')));
  assert.throws(() => buildDirectVisibleEdgeArgs(cacheDir, token, 'https://example.com/login'), { code: 'EDGE_LAUNCH_URL_INVALID' });
});

test('remote navigation happens only after launch and ownership proof, and readiness requires a visible owned window', async () => {
  const mock = harness();
  assert.equal(await mock.launch(), mock.browserContext);
  assert.deepEqual(mock.calls, ['launch', 'ownership', 'navigate', 'visible']);
});

test('an ownership mismatch closes only the newly launched context and never reports readiness', async () => {
  const ownershipError = Object.assign(new Error('unowned context'), { code: 'EDGE_OWNERSHIP_UNPROVEN' });
  const mock = harness({ ownershipError });
  await assert.rejects(mock.launch(), { code: 'EDGE_OWNERSHIP_UNPROVEN' });
  assert.deepEqual(mock.calls, ['launch', 'ownership', 'close-owned-context']);
});

test('a connected browser without visible-window proof still fails and releases its context', async () => {
  const visibilityError = Object.assign(new Error('no visible window'), { code: 'EDGE_WINDOW_NOT_VISIBLE' });
  const mock = harness({ visibilityError });
  await assert.rejects(mock.launch(), { code: 'EDGE_WINDOW_NOT_VISIBLE' });
  assert.deepEqual(mock.calls, ['launch', 'ownership', 'navigate', 'visible', 'close-owned-context']);
});

test('startup timeout is distinct from spawn failure and never emits sensitive Playwright diagnostic text', async () => {
  const cause = Object.assign(new Error('Timeout 20000ms exceeded. --token=private-value https://login.1688.com/?account=private-account'), { name: 'TimeoutError' });
  const mock = harness({ launchError: cause });
  await assert.rejects(mock.launch(), error => {
    assert.equal(error.code, 'EDGE_STARTUP_TIMEOUT');
    assert.equal(error.cause, cause);
    assert.equal(error.details.stage, 'browser_launch');
    assert.equal(error.details.category, 'edge_startup_timeout');
    const cliPayload = JSON.stringify({ code: error.code, message: error.message, details: error.details });
    assert.doesNotMatch(cliPayload, /private-value|private-account|https:\/\/login/);
    return true;
  });
  assert.deepEqual(mock.calls, ['launch']);
});

test('known profile-use and executable errors remain actionable even when wrapped in a timeout', () => {
  const busy = classifyNativeEdgeLaunchFailure(Object.assign(new Error('Timeout 20000ms exceeded: ProcessSingleton: user data directory is already in use'), { name: 'TimeoutError' }));
  assert.equal(busy.code, 'EDGE_PROFILE_BUSY');
  assert.equal(busy.exitCode, 5);
  assert.equal(busy.details.category, 'edge_profile_busy');
  const missing = classifyNativeEdgeLaunchFailure(new Error("Executable doesn't exist at private-path"));
  assert.equal(missing.code, 'EDGE_MISSING');
  assert.equal(missing.details.retryable, false);
  const generic = classifyNativeEdgeLaunchFailure(new Error('spawn failed'));
  assert.equal(generic.code, 'EDGE_LAUNCH_FAILED');
});
