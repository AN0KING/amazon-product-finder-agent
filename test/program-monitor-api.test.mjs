import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { request as httpRequest } from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import os from "node:os";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scout-program-monitor-api-"));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const guardPath = path.join(temporaryRoot, "mock-only-monitor-reads.mjs");
const bridgePaths = ["/api/v1/runtime", "/api/v1/queue/rate-trial"];

// The child may accept this test's loopback HTTP requests, but it cannot open
// any outbound socket or process. fetch never delegates to the real network.
await writeFile(guardPath, `
  import net from "node:net";
  import tls from "node:tls";
  import childProcess from "node:child_process";
  import { appendFileSync } from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  const deny = kind => {
    appendFileSync(process.env.SCOUT_TEST_DENIED_LOG, kind + "\\n");
    throw new Error("Unexpected outbound operation in isolated monitor test");
  };
  net.Socket.prototype.connect = () => deny("socket");
  tls.connect = () => deny("tls");
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    childProcess[key] = () => deny("process");
  }
  globalThis.fetch = async (input, options = {}) => {
    const value = String(input);
    const allowed = ${JSON.stringify(bridgePaths.map(endpoint => "http://127.0.0.1:16880" + endpoint))};
    if (!allowed.includes(value) || options.method !== "GET" || options.redirect !== "error") return deny("fetch");
    appendFileSync(process.env.SCOUT_TEST_FETCH_LOG, JSON.stringify({ url: value, method: options.method }) + "\\n");
    if (process.env.SCOUT_TEST_BRIDGE === "missing") throw Object.assign(new Error("Synthetic bridge is absent"), { code: "ECONNREFUSED" });
    const rateTrial = { createdAt: 1791793800000, status: "waiting", targetPerHour: 90, currentStage: null, history: [], trigger: null };
    const ratePolicy = { minGapMs: 40000, maxConcurrent: 1, pausedReason: null, rateTrial };
    const data = value.endsWith("/runtime")
      ? { product: "1688-procurement-assistant", version: "2.3.0", auth: { ready: true }, queue: { queued: 0, running: 0, riskBlocked: 0, ratePolicy } }
      : { ratePolicy };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  syncBuiltinESMExports();
`);

after(async () => {
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith("scout-program-monitor-api-"));
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function textFileOrEmpty(filename) {
  return readFile(filename, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
}
async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.notEqual(port, 4173);
  assert.notEqual(port, 16880);
  return port;
}
function api(origin, endpoint) {
  const url = new URL(endpoint, origin);
  assert.equal(url.hostname, "127.0.0.1");
  assert.notEqual(url.port, "4173");
  assert.notEqual(url.port, "16880");
  assert.ok(["/api/version", "/api/monitor", "/api/sellsprite/status", "/api/amazon/collection"].includes(url.pathname));
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "GET", headers: { Connection: "close", Origin: origin } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("Isolated test API timed out")));
    request.end();
  });
}
async function until(read, accept, message) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const result = await read();
    if (accept(result)) return result;
    await delay(25);
  }
  assert.fail(message);
}

let sequence = 0;
async function isolatedServer(t, { bridge = "healthy", sellerConfig = "missing", enabled = true, corrupt = null } = {}) {
  const directory = path.join(temporaryRoot, `case-${++sequence}`);
  const dataDirectory = path.join(directory, "data");
  await mkdir(dataDirectory, { recursive: true });
  const statePath = path.join(dataDirectory, "program-monitor.json");
  if (corrupt !== null) await writeFile(statePath, corrupt);
  const configPath = path.join(directory, "sellersprite.local.toml");
  if (sellerConfig === "invalid") await writeFile(configPath, "[sellersprite]\nurl = [invalid syntax\n");
  const deniedLog = path.join(directory, "denied.log");
  const fetchLog = path.join(directory, "fetch.log");
  const origin = `http://127.0.0.1:${await freePort()}`;
  // No AI-client settings or provider credentials are inherited by the child.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CODEX|OPENAI|CHATGPT|SELLERSPRITE|SCOUT_)/i.test(name)));
  Object.assign(env, {
    SCOUT_PORT: new URL(origin).port, SCOUT_DATA_DIR: dataDirectory,
    SCOUT_SELLERSPRITE_CONFIG_PATH: configPath, SCOUT_TEST_DENIED_LOG: deniedLog,
    SCOUT_TEST_FETCH_LOG: fetchLog, SCOUT_TEST_BRIDGE: bridge,
  });
  if (!enabled) env.SCOUT_MONITOR_ENABLED = "0";
  const child = spawn(process.execPath, ["--import", pathToFileURL(guardPath).href, path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env,
  });
  const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  let output = "", spawnError;
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.once("error", error => { spawnError = error; });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    assert.equal(await textFileOrEmpty(deniedLog), "", "Monitor must never authorize a provider, request health, or launch a process");
  });
  await until(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Isolated monitor service exited: ${output}`);
    try { return (await api(origin, "/api/version")).status === 200; }
    catch (error) { if (!["ECONNREFUSED", "ECONNRESET"].includes(error.code)) throw error; return false; }
  }, Boolean, "Isolated monitor server did not start");
  return { origin, statePath, fetchLog,
    monitor: async () => { const result = await api(origin, "/api/monitor"); assert.equal(result.status, 200); assert.equal(result.body.ok, true); return result.body.data; },
    fetches: async () => (await textFileOrEmpty(fetchLog)).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
  };
}

for (const [bridge, sellerConfig, supplierStatus] of [["missing", "missing", "unavailable"], ["healthy", "invalid", "waiting"]]) {
  test(`default program monitoring is independent of AI and optional SellerSprite (${bridge} bridge, ${sellerConfig} config)`, { timeout: 15000 }, async t => {
    const service = await isolatedServer(t, { bridge, sellerConfig });
    const state = await until(service.monitor, value => Boolean(value.checks.amazon.lastCheckedAt && value.checks.supplier1688.lastCheckedAt), "Startup checks were not saved");
    assert.equal(state.configured, true);
    assert.equal(state.enabled, true);
    assert.equal(state.errorCode, null);
    assert.equal(state.persistenceError, null);
    assert.deepEqual(state.intervals, { amazonMs: 900000, supplier1688Ms: 1800000 });
    assert.equal(state.checks.amazon.status, "idle");
    assert.equal(state.checks.supplier1688.status, supplierStatus);
    assert.equal(state.checks.supplier1688.hasActivity, false);
    assert.deepEqual(state.events, []);
    const disk = await until(async () => JSON.parse(await textFileOrEmpty(service.statePath) || "null"),
      value => Boolean(value?.checks?.amazon?.lastCheckedAt && value?.checks?.supplier1688?.lastCheckedAt), "Monitor state was not persisted");
    assert.equal(disk.version, 1);
    assert.deepEqual(disk.events, []);
    const before = await service.fetches();
    assert.deepEqual(before.map(item => new URL(item.url).pathname).sort(), [...bridgePaths].sort());
    assert.ok(before.every(item => item.method === "GET" && !item.url.includes("?") && !item.url.includes("health")));
    for (let index = 0; index < 5; index += 1) assert.deepEqual(await service.monitor(), state);
    assert.deepEqual(await service.fetches(), before, "GET /api/monitor must read a snapshot without another upstream check");
    const seller = await api(service.origin, "/api/sellsprite/status");
    assert.equal(seller.status, 200);
    assert.equal(seller.body.data.connected, false);
    assert.equal(seller.body.data.configuration.configured, false);
    assert.equal(seller.body.data.toolCallCount, 0);
    const version = await api(service.origin, "/api/version");
    assert.equal(version.body.data.toolCallCount, 0);
    assert.equal(version.body.data.activeSearchRequests, 0);
    assert.equal(version.body.data.activeAmazonRequests, 0);
    assert.equal(version.body.data.active1688Requests, 0);
    assert.deepEqual(await service.fetches(), before);
  });
}

test("explicitly disabled monitoring remains disabled and performs no bridge reads", { timeout: 15000 }, async t => {
  const service = await isolatedServer(t, { enabled: false });
  const state = await service.monitor();
  assert.equal(state.configured, false);
  assert.equal(state.enabled, false);
  assert.equal(state.errorCode, null);
  assert.equal(state.checks.amazon.lastCheckedAt, null);
  assert.equal(state.checks.supplier1688.lastCheckedAt, null);
  assert.deepEqual(state.events, []);
  for (let index = 0; index < 3; index += 1) await service.monitor();
  assert.deepEqual(await service.fetches(), []);
  assert.equal(await textFileOrEmpty(service.statePath), "");
});

for (const corrupt of ["not valid JSON", JSON.stringify({ version: 1, checks: {} })]) {
  test(`corrupt monitor state reports a stopped configured service without resetting persisted evidence (${corrupt.startsWith("{") ? "schema" : "JSON"})`, { timeout: 15000 }, async t => {
    const service = await isolatedServer(t, { corrupt });
    const state = await until(service.monitor, value => value.errorCode !== null, "Monitor startup error was not exposed");
    assert.equal(state.configured, true);
    assert.equal(state.enabled, false);
    assert.equal(state.errorCode, "PROGRAM_MONITOR_START_FAILED");
    assert.equal(state.checks.amazon.lastCheckedAt, null);
    assert.equal(state.checks.supplier1688.lastCheckedAt, null);
    assert.deepEqual(state.events, []);
    assert.equal(await readFile(service.statePath, "utf8"), corrupt);
    for (let index = 0; index < 3; index += 1) assert.deepEqual(await service.monitor(), state);
    assert.deepEqual(await service.fetches(), []);
    assert.equal(JSON.stringify(state).includes(temporaryRoot), false);
  });
}
