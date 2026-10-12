const BRIDGE_ORIGIN = "http://127.0.0.1:16880";
const READ_PATHS = ["/api/v1/runtime", "/api/v1/queue/rate-trial"];

// Monitoring uses these two cached, local status endpoints directly. The normal
// procurement client's readiness probe must not turn a poll into verification.
export async function readSupplierMonitoringState({ pipeline = null, fetchImpl = globalThis.fetch, signal } = {}) {
  const results = await Promise.allSettled(READ_PATHS.map(async (endpoint) => {
    const response = await fetchImpl(BRIDGE_ORIGIN + endpoint, {
      method: "GET", redirect: "error", signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error("BRIDGE_STATUS_UNAVAILABLE");
    const payload = await response.json();
    if (payload?.ok !== true) throw new Error("BRIDGE_STATUS_UNAVAILABLE");
    return payload.data ?? payload;
  }));
  if (results.some(result => result.status === "rejected")) {
    return { available: false, pipeline, errorCode: "BRIDGE_UNAVAILABLE" };
  }
  const [runtime, trial] = results.map(result => result.value);
  if (runtime?.product !== "1688-procurement-assistant" || runtime?.version !== "2.3.0"
    || !runtime.queue || !trial?.ratePolicy || typeof trial.ratePolicy !== "object") {
    return { available: false, pipeline, errorCode: "BRIDGE_STATUS_INVALID" };
  }
  return { available: true, pipeline, runtime, ratePolicy: trial.ratePolicy };
}
