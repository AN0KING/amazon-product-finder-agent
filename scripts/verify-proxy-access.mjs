// Standalone check: verifies that outbound Amazon access works through the
// configured proxy (HTTPS_PROXY / HTTP_PROXY environment variables).
// Usage: node scripts/verify-proxy-access.mjs [https://www.amazon.com.au]
import "../lib/fetch-proxy.mjs";

const target = process.argv[2] || "https://www.amazon.com.au";
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
console.log(`target: ${target}`);
console.log(`proxy:  ${proxy || "(none - direct connection)"}`);

try {
  const response = await fetch(target, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
      "Accept-Language": "en-AU,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  const challenge = /\/(?:_sec\/verify|errors\/validatecaptcha|ap\/cvf)\b|bm-verify|robot check|enter the characters you see below|unusual activity/i.test(body);
  console.log(`status: ${response.status}`);
  console.log(`body bytes: ${Buffer.byteLength(body, "utf8")}`);
  console.log(`challenge detected: ${challenge}`);
  console.log(challenge ? "RESULT: BLOCKED - Amazon still returns a verification page." : "RESULT: OK - Amazon page reached without a challenge.");
} catch (error) {
  console.log(`request failed: ${error?.cause?.code || error?.code || error?.message}`);
  if (!proxy) {
    console.log("RESULT: FAILED - no proxy configured and direct access did not work.");
  } else {
    console.log("RESULT: FAILED - proxy is configured but unreachable. Is the proxy client (Clash/V2Ray) running?");
  }
}
