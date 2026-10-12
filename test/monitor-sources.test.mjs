import test from "node:test";
import assert from "node:assert/strict";
import { readSupplierMonitoringState } from "../lib/monitor-sources.mjs";

const policy = { rateTrial: { status: "waiting", createdAt: 1, currentStage: null, history: [] } };
const runtime = { ok: true, product: "1688-procurement-assistant", version: "2.3.0", auth: { ready: true }, queue: { ratePolicy: policy } };

test("monitor reads only cached local runtime and trial, without verification or health", async () => {
  const calls = [];
  const pipeline = { runId: "synthetic", status: "running" };
  const result = await readSupplierMonitoringState({ pipeline, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, redirect: options.redirect });
    return Response.json(url.endsWith("/runtime") ? runtime : { ok: true, ratePolicy: policy });
  } });
  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:16880/api/v1/runtime", method: "GET", redirect: "error" },
    { url: "http://127.0.0.1:16880/api/v1/queue/rate-trial", method: "GET", redirect: "error" },
  ]);
  assert.equal(result.available, true);
  assert.deepEqual(result.pipeline, pipeline);
  assert.deepEqual(result.ratePolicy, policy);
});

test("missing optional bridge preserves local work identity and reveals no transport text", async () => {
  const pipeline = { runId: "synthetic", status: "queued" };
  const result = await readSupplierMonitoringState({ pipeline, fetchImpl: async () => { throw new Error("sensitive-transport-text"); } });
  assert.deepEqual(result, { available: false, pipeline, errorCode: "BRIDGE_UNAVAILABLE" });
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
});

test("foreign or malformed bridge status is not trusted as trial evidence", async () => {
  for (const value of [{ ...runtime, product: "other" }, { ...runtime, queue: null }, { ok: false }]) {
    const result = await readSupplierMonitoringState({ fetchImpl: async (url) => Response.json(url.endsWith("/runtime") ? value : { ok: true, ratePolicy: policy }) });
    assert.equal(result.available, false);
  }
});
