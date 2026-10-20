import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { localDirectory } from "../1688-dependencies/1688-image-finder/dist/util/local-path.js";
import { resolve1688RuntimePaths, LEGACY_PROCUREMENT_ROOT, LEGACY_IMAGE_FINDER_ROOT } from "../1688-dependencies/1688-procurement-assistant-2.3.0/lib/runtime-paths.mjs";
import { brokerSignalPath } from "../1688-dependencies/1688-image-finder/dist/session/broker-paths.js";
import { resolveScout1688RuntimePaths } from "../scripts/start-1688-dependency.mjs";
import { resolveConsoleRuntime } from "../1688-dependencies/1688-procurement-assistant-2.3.0/scripts/1688-console-launcher.mjs";
import { createProcurementStore } from "../1688-dependencies/1688-image-finder/dist/procurement/store.js";

const nonexistentFs = { lstatSync() { throw Object.assign(new Error("fixture"), { code: "ENOENT" }); } };
const windowsOptions = { platform: "win32", fsImpl: nonexistentFs };
const installRoot = "C:\\Users\\同事 Alice\\AppData\\Local\\店铺分析 Agent";
const portableEnv = {
  SCOUT_1688_PROJECT_ROOT: path.win32.join(installRoot, "app", "1688-dependencies", "1688-procurement-assistant-2.3.0"),
  BB1688_IMAGE_FINDER_ROOT: path.win32.join(installRoot, "app", "1688-dependencies", "1688-image-finder"),
  BB1688_HOME: path.win32.join(installRoot, "data", "1688-session"),
  BB1688_DATA_ROOT: path.win32.join(installRoot, "data", "sourcing-console"),
};

test("portable paths use only the C drive installation and isolated data with spaces and Chinese", () => {
  const actual = resolve1688RuntimePaths({ env: portableEnv, ...windowsOptions });
  assert.deepEqual(actual, { procurementRoot: portableEnv.SCOUT_1688_PROJECT_ROOT,
    imageFinderRoot: portableEnv.BB1688_IMAGE_FINDER_ROOT, sessionRoot: portableEnv.BB1688_HOME, dataRoot: portableEnv.BB1688_DATA_ROOT });
  assert.ok(Object.values(actual).every(value => !value.startsWith("D:")));
});

test("unconfigured legacy installation keeps its existing components and logged-in session directory", () => {
  const actual = resolve1688RuntimePaths({ env: {}, ...windowsOptions });
  assert.equal(actual.procurementRoot, LEGACY_PROCUREMENT_ROOT);
  assert.equal(actual.imageFinderRoot, LEGACY_IMAGE_FINDER_ROOT);
  assert.equal(actual.sessionRoot, path.win32.join(LEGACY_IMAGE_FINDER_ROOT, "data", "1688-session"));
  assert.equal(actual.dataRoot, path.win32.join(LEGACY_PROCUREMENT_ROOT, "data", "sourcing-console"));
});

for (const unsafe of ["\\\\server\\share\\session", "\\\\?\\C:\\session", "\\\\.\\C:\\session", "C:session", "session", "C:\\", "C:\\app\\..\\session", "C:\\app\\session:secret", "C:\\app\\NUL", "C:\\app\\session.", "C:\\app\\bad\0name"]) {
  test(`unsafe session path is rejected: ${JSON.stringify(unsafe)}`, () => {
    assert.throws(() => resolve1688RuntimePaths({ env: { ...portableEnv, BB1688_HOME: unsafe }, ...windowsOptions }));
    assert.throws(() => createProcurementStore({ rootDir: unsafe }));
  });
}

test("symbolic links and realpath aliases are rejected even if the target is on the same drive", () => {
  const candidate = "C:\\data\\alias\\session";
  const fakeFs = {
    lstatSync: value => ({ isSymbolicLink: () => value === "C:\\data\\alias", isDirectory: () => true }),
    realpathSync: { native: value => value },
  };
  assert.throws(() => localDirectory(candidate, "session", { platform: "win32", fsImpl: fakeFs }), /reparse|symbolic/);
  fakeFs.lstatSync = () => ({ isSymbolicLink: () => false, isDirectory: () => true });
  fakeFs.realpathSync.native = value => value === "C:\\data\\alias" ? "C:\\other" : value;
  assert.throws(() => localDirectory(candidate, "session", { platform: "win32", fsImpl: fakeFs }), /reparse|symbolic/);
});

test("packaged dependency startup passes exact isolated roots without launching a service or browser", async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "scout 中文 portable "));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const env = { ...process.env, SCOUT_1688_PROJECT_ROOT: path.join(fixture, "app", "1688-procurement-assistant-2.3.0"),
    BB1688_IMAGE_FINDER_ROOT: path.join(fixture, "app", "1688-image-finder"),
    BB1688_HOME: path.join(fixture, "data", "session"), BB1688_DATA_ROOT: path.join(fixture, "data", "sourcing") };
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { start1688Dependency } = await import(process.argv[1]);
    const result = await start1688Dependency({ launchConsoleImpl: async options => ({ projectRoot: options.projectRoot, runtimeEnv: options.runtimeEnv }) });
    const paths = await import(process.argv[2]);
    await paths.ensureRoot();
    await (await import('node:fs/promises')).writeFile(paths.stateFile('default'), '{}');
    console.log(JSON.stringify({ ...result, stateFile: paths.stateFile('default') }));
  `, new URL("../scripts/start-1688-dependency.mjs", import.meta.url).href,
  new URL("../1688-dependencies/1688-image-finder/dist/session/paths.js", import.meta.url).href], { encoding: "utf8", env, timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const actual = JSON.parse(run.stdout.trim());
  assert.equal(actual.projectRoot, env.SCOUT_1688_PROJECT_ROOT);
  assert.equal(actual.sessionRoot, env.BB1688_HOME);
  assert.deepEqual(actual.runtimeEnv, Object.fromEntries(Object.keys(portableEnv).map(key => [key, env[key]])));
  assert.equal(actual.stateFile, path.join(env.BB1688_HOME, "state.json"));
});

test("procurement store accepts a C-drive directory", { skip: process.platform !== "win32" }, async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "scout portable store "));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const store = createProcurementStore({ rootDir: path.join(fixture, "sourcing") });
  assert.deepEqual(await store.listTasks(), []);
});

for (const extension of ['ready', 'cancel']) {
  test(`broker ${extension} signal is restricted to the exact portable data directory`, () => {
    const basename = `launch-123-12345678-1234-1234-1234-123456789abc.${extension}`;
    const signal = path.win32.join(portableEnv.BB1688_DATA_ROOT, 'runtime-cache', 'login-handshakes', basename);
    assert.equal(brokerSignalPath(signal, extension, { env: portableEnv, ...windowsOptions }), signal);
    assert.throws(() => brokerSignalPath(path.win32.join('C:\\other', 'data', 'sourcing-console', 'runtime-cache', 'login-handshakes', basename), extension, { env: portableEnv, ...windowsOptions }));
    assert.throws(() => brokerSignalPath(signal.replace(basename, `wrong.${extension}`), extension, { env: portableEnv, ...windowsOptions }));
  });
}

const sourceRoot = "C:\\开发目录\\店铺 Agent";
const vendoredBridge = path.win32.join(sourceRoot, "1688-dependencies", "1688-procurement-assistant-2.3.0");
const legacyData = path.win32.join(LEGACY_PROCUREMENT_ROOT, "data", "sourcing-console");
const legacySession = path.win32.join(LEGACY_IMAGE_FINDER_ROOT, "data", "1688-session");

for (const [name, env, expected] of [
  ["source defaults", {}, { procurementRoot: vendoredBridge, imageFinderRoot: LEGACY_IMAGE_FINDER_ROOT, sessionRoot: legacySession, dataRoot: legacyData }],
  ["all portable overrides", portableEnv, { procurementRoot: portableEnv.SCOUT_1688_PROJECT_ROOT, imageFinderRoot: portableEnv.BB1688_IMAGE_FINDER_ROOT,
    sessionRoot: portableEnv.BB1688_HOME, dataRoot: portableEnv.BB1688_DATA_ROOT }],
  ["only bridge root override", { SCOUT_1688_PROJECT_ROOT: "C:\\legacy custom bridge" }, {
    procurementRoot: "C:\\legacy custom bridge", imageFinderRoot: LEGACY_IMAGE_FINDER_ROOT, sessionRoot: legacySession,
    dataRoot: "C:\\legacy custom bridge\\data\\sourcing-console" }],
]) {
  test(`${name}: source entry and actual launcher agree on code, queue, and session without mutating environment`, () => {
    const before = { ...env };
    const actual = resolveScout1688RuntimePaths({ env, scoutRoot: sourceRoot, ...windowsOptions });
    assert.deepEqual(actual, expected);
    const runtimeEnv = { SCOUT_1688_PROJECT_ROOT: actual.procurementRoot, BB1688_IMAGE_FINDER_ROOT: actual.imageFinderRoot,
      BB1688_HOME: actual.sessionRoot, BB1688_DATA_ROOT: actual.dataRoot };
    const launched = resolveConsoleRuntime({ projectRoot: actual.procurementRoot, runtimeEnv, env, ...windowsOptions });
    assert.deepEqual(launched.runtimePaths, expected);
    for (const [key, value] of Object.entries(runtimeEnv)) assert.equal(launched.childEnv[key], value);
    assert.deepEqual(env, before);
  });
}

test("source entry preserves explicit data/session settings while selecting bundled bridge code", () => {
  const actual = resolveScout1688RuntimePaths({ env: { BB1688_DATA_ROOT: "C:\\old queue", BB1688_HOME: "C:\\existing login" },
    scoutRoot: sourceRoot, ...windowsOptions });
  assert.equal(actual.procurementRoot, vendoredBridge);
  assert.equal(actual.dataRoot, "C:\\old queue");
  assert.equal(actual.sessionRoot, "C:\\existing login");
  assert.equal(actual.imageFinderRoot, LEGACY_IMAGE_FINDER_ROOT);
});
