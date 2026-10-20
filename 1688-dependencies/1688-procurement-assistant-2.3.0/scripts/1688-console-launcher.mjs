// 1688 采购助手启动器
// 供店铺分析 Agent 的 scripts/start-1688-dependency.mjs 调用：
//   launchConsole({ projectRoot, interactive, startupTimeoutMs, brokerStartupTimeoutMs })
// 以分离进程启动本目录的 server.mjs（监听 127.0.0.1:16880），并等待健康检查就绪。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve1688RuntimePaths } from "../lib/runtime-paths.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEALTH_URL = "http://127.0.0.1:16880/api/v1/health";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function healthOk(timeoutMs = 2_000) {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    return payload?.ok === true
      && payload?.product === "1688-procurement-assistant"
      && payload?.version === "2.3.0";
  } catch {
    return false;
  }
}

export function resolveConsoleRuntime({ projectRoot = PROJECT_ROOT, runtimeEnv = {}, env = process.env,
  platform = process.platform, fsImpl } = {}) {
  const inherited = { ...env };
  for (const key of ["SCOUT_1688_PROJECT_ROOT", "BB1688_IMAGE_FINDER_ROOT", "BB1688_HOME", "BB1688_DATA_ROOT"]) {
    if (Object.hasOwn(runtimeEnv, key)) inherited[key] = runtimeEnv[key];
  }
  const runtimePaths = resolve1688RuntimePaths({ projectRoot, env: inherited, platform, ...(fsImpl ? { fsImpl } : {}) });
  return { runtimePaths, childEnv: { ...inherited,
    SCOUT_1688_PROJECT_ROOT: runtimePaths.procurementRoot,
    BB1688_IMAGE_FINDER_ROOT: runtimePaths.imageFinderRoot,
    BB1688_HOME: runtimePaths.sessionRoot,
    BB1688_DATA_ROOT: runtimePaths.dataRoot,
  } };
}

export async function launchConsole({
  projectRoot = PROJECT_ROOT,
  runtimeEnv = {},
  interactive = false,
  startupTimeoutMs = 60_000,
  brokerStartupTimeoutMs = 30_000,
} = {}) {
  void interactive;
  void brokerStartupTimeoutMs;
  if (await healthOk()) {
    return { alreadyRunning: true, healthUrl: HEALTH_URL, projectRoot };
  }
  const { runtimePaths, childEnv } = resolveConsoleRuntime({ projectRoot: projectRoot || PROJECT_ROOT, runtimeEnv });
  const root = runtimePaths.procurementRoot;
  const logDir = path.join(runtimePaths.dataRoot, "logs");
  await fsp.mkdir(logDir, { recursive: true });
  const stdout = fs.openSync(path.join(logDir, "service-stdout.log"), "a");
  const stderr = fs.openSync(path.join(logDir, "service-stderr.log"), "a");
  const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
    env: childEnv,
  });
  child.unref();
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  const deadline = Date.now() + Math.max(5_000, Number(startupTimeoutMs) || 60_000);
  while (Date.now() < deadline) {
    await delay(400);
    if (await healthOk()) {
      return { started: true, pid: child.pid, healthUrl: HEALTH_URL, projectRoot: root };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`1688 采购助手进程启动后立即退出（code=${child.exitCode ?? child.signalCode}），请查看 data/sourcing-console/logs。`);
    }
  }
  throw new Error("1688 采购助手在启动超时内未能就绪。");
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  launchConsole()
    .then((result) => {
      process.stdout.write(`1688 采购助手已就绪：${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
