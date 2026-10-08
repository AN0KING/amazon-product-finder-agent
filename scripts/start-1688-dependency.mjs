import path from "node:path";
import { connect } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROCUREMENT_PROJECT_ROOT = "D:\\deliverables\\1688-procurement-assistant-2.3.0";
export const BB1688_HOME = "D:\\deliverables\\1688-procurement-assistant-2.3.0\\data\\1688-session";
export const PROCUREMENT_HEALTH_URL = "http://127.0.0.1:16880/api/v1/health";
export const PROCUREMENT_INTEGRATION_PROTOCOL = 8;
const HEALTH_PROBE_ATTEMPTS = 2;
const HEALTH_PROBE_RETRY_DELAY_MS = 250;
const RECOVERY_SETTLE_DELAY_MS = 500;

let dependencyRecoveryPromise = null;

export class ProcurementDependencyError extends Error {
  constructor(code, message, status = 503, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProcurementDependencyError";
    this.code = code;
    this.status = status;
  }
}

export async function get1688DependencyStatus({
  fetchImpl = globalThis.fetch,
  portProbeImpl = isProcurementPortOpen,
  timeoutMs = 1_500,
  attempts = HEALTH_PROBE_ATTEMPTS,
  retryDelayMs = HEALTH_PROBE_RETRY_DELAY_MS,
  waitImpl = delay,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  const probeAttempts = Math.max(1, Math.min(3, Math.trunc(Number(attempts) || HEALTH_PROBE_ATTEMPTS)));
  let response;
  for (let attempt = 1; attempt <= probeAttempts; attempt += 1) {
    try {
      response = await fetchImpl(PROCUREMENT_HEALTH_URL, {
        headers: { "Sec-Fetch-Site": "same-origin" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch {
      if (attempt < probeAttempts) await waitImpl(Math.max(0, Number(retryDelayMs) || 0));
    }
  }
  if (!response) return await portProbeImpl() ? "foreign" : "down";
  if (!response.ok) return "foreign";
  let payload;
  try {
    payload = await response.json();
  } catch {
    return "foreign";
  }
  const expectedProduct = payload?.product === "1688-procurement-assistant"
    && payload?.version === "2.3.0"
    && payload?.loginBrokerProtocol === 5;
  if (!expectedProduct) return "foreign";
  return payload?.integrationProtocol === PROCUREMENT_INTEGRATION_PROTOCOL
    && payload?.capabilities?.imageCandidateLimit === 40
    && payload?.capabilities?.supplierStrengthRefresh === true
    && payload?.capabilities?.automaticSupplierStrength === true
    && payload?.capabilities?.automaticSupplierStrengthEnabled === true
    && payload?.capabilities?.imageSearchRiskRecovery === true
    && payload?.capabilities?.excelBatchImport === true
    && payload?.capabilities?.imageSearchWithoutPrice === true
    && payload?.capabilities?.persistentSearchRateLimit === true
    && payload?.capabilities?.manualRiskResume === true
    ? "ready"
    : "outdated";
}

export async function ensure1688Dependency({
  launchConsoleImpl,
  healthCheckImpl = get1688DependencyStatus,
  waitImpl = delay,
} = {}) {
  if (dependencyRecoveryPromise) return dependencyRecoveryPromise;
  const pending = recover1688Dependency({ launchConsoleImpl, healthCheckImpl, waitImpl })
    .finally(() => {
      if (dependencyRecoveryPromise === pending) dependencyRecoveryPromise = null;
    });
  dependencyRecoveryPromise = pending;
  return pending;
}

async function recover1688Dependency({ launchConsoleImpl, healthCheckImpl, waitImpl }) {
  const initialStatus = await healthCheckImpl();
  if (initialStatus === "ready") {
    return { status: "ready", alreadyRunning: true, sessionRoot: BB1688_HOME };
  }
  if (initialStatus === "foreign") throw identityMismatchError();

  // A service restart has a short interval where the loopback port is absent.
  // Recheck before invoking the credentialed launcher so concurrent callers do
  // not stop and replace a companion that has already recovered.
  await waitImpl(RECOVERY_SETTLE_DELAY_MS);
  const settledStatus = await healthCheckImpl();
  if (settledStatus === "ready") {
    return {
      status: "ready",
      alreadyRunning: true,
      recoveredDuringProbe: true,
      sessionRoot: BB1688_HOME,
    };
  }
  if (settledStatus === "foreign") throw identityMismatchError();

  try {
    const result = await start1688Dependency({ launchConsoleImpl });
    return { ...result, status: "ready" };
  } catch (cause) {
    const finalStatus = await healthCheckImpl();
    if (finalStatus === "ready") {
      return { status: "ready", alreadyRunning: true, recoveredAfterRace: true, sessionRoot: BB1688_HOME };
    }
    if (finalStatus === "foreign") throw identityMismatchError(cause);
    throw new ProcurementDependencyError(
      "PROCUREMENT_CONSOLE_START_FAILED",
      "1688 采购助手启动失败，请查看本机启动日志。",
      503,
      cause,
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

export async function start1688Dependency({ launchConsoleImpl } = {}) {
  const launchConsole = launchConsoleImpl || await loadLauncher();
  const result = await launchConsole({
    projectRoot: PROCUREMENT_PROJECT_ROOT,
    interactive: true,
    startupTimeoutMs: 60_000,
    brokerStartupTimeoutMs: 30_000,
  });
  return {
    ...result,
    sessionRoot: BB1688_HOME,
  };
}

async function loadLauncher() {
  const modulePath = path.join(
    PROCUREMENT_PROJECT_ROOT,
    "scripts",
    "1688-console-launcher.mjs",
  );
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.launchConsole !== "function") {
    throw new Error("1688 采购助手启动器缺少 launchConsole。\n");
  }
  return module.launchConsole;
}

function identityMismatchError(cause = null) {
  return new ProcurementDependencyError(
    "PROCUREMENT_CONSOLE_IDENTITY_MISMATCH",
    "本机 16880 端口不是兼容版本的 1688 采购助手，已停止自动启动。",
    409,
    cause,
  );
}

function isProcurementPortOpen() {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: 16880 });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  start1688Dependency()
    .then((result) => {
      process.stdout.write(
        `1688 采购助手已就绪；固定会话目录：${result.sessionRoot}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
