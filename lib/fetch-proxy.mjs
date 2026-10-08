// Optional outbound proxy support for the local Scout server.
//
// Node's built-in fetch (undici) ignores HTTP_PROXY / HTTPS_PROXY environment
// variables and the Windows system proxy settings. On networks where Amazon
// blocks direct access from the local egress IP, the deployment can route all
// outbound server traffic through a local proxy (e.g. a Clash/V2Ray mixed
// port) by setting these variables before starting server.mjs:
//
//   HTTPS_PROXY=http://127.0.0.1:7897
//   HTTP_PROXY=http://127.0.0.1:7897
//   NO_PROXY=127.0.0.1,localhost,::1
//
// When the variables are absent this module is a no-op and the server behaves
// exactly as before (direct connections).
//
// Dual-egress failover: Amazon's WAF sometimes throttles one egress IP while
// leaving the other usable (e.g. proxy exit node gets HTTP 503 on deep
// pagination). createDualEgressFetch() returns a fetch implementation that
// tries the proxy first and silently retries the same GET through the direct
// route when the proxy returns a transient 5xx/429 status.
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const proxyUrl = process.env.HTTPS_PROXY
  || process.env.https_proxy
  || process.env.HTTP_PROXY
  || process.env.http_proxy;

if (proxyUrl) {
  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    process.env.NO_PROXY = "127.0.0.1,localhost,::1";
  }
  setGlobalDispatcher(new EnvHttpProxyAgent());
  process.stdout.write(`Scout Amazon outbound proxy enabled: ${proxyUrl}\n`);
}

const FAILOVER_STATUSES = new Set([429, 500, 502, 503, 504]);
let directAgent = null;

export function proxyConfigured() {
  return Boolean(proxyUrl);
}

export function createDualEgressFetch() {
  if (!proxyUrl) return globalThis.fetch;
  directAgent ||= new Agent({
    connect: { timeout: 15_000 },
    headersTimeout: 60_000,
    bodyTimeout: 60_000,
  });
  return async function dualEgressFetch(url, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const response = await fetch(url, options);
    const status = Number(response?.status);
    if (!FAILOVER_STATUSES.has(status) || method !== "GET") return response;
    // Proxy egress is being throttled; retry the same GET directly.
    try {
      const directResponse = await fetch(url, { ...options, dispatcher: directAgent });
      const directStatus = Number(directResponse?.status);
      if (directStatus >= 200 && directStatus < 300) return directResponse;
      await cancelQuietly(directResponse);
      return response;
    } catch {
      return response;
    }
  };
}

async function cancelQuietly(response) {
  try {
    await response?.body?.cancel?.();
  } catch {}
}
