// Test: does a cookie-carrying retry pass the AWS WAF challenge?
import "../lib/fetch-proxy.mjs";

const target = process.argv[2] || "https://www.amazon.com.au";
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
  "Accept-Language": "en-AU,en;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "Cache-Control": "no-cache",
  "Upgrade-Insecure-Requests": "1",
};
const CHALLENGE_RE = /awswaf\.com|AwsWafIntegration|challenge-container|window\.gokuProps|validatecaptcha|ap\/cvf|robot check|not a robot/i;

const jar = new Map();
for (let attempt = 1; attempt <= 4; attempt += 1) {
  const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await fetch(target, {
    headers: cookieHeader ? { ...headers, Cookie: cookieHeader } : headers,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  const isChallenge = CHALLENGE_RE.test(body);
  const setCookies = response.headers.getSetCookie?.() || [];
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  console.log(`attempt ${attempt}: status=${response.status} bytes=${Buffer.byteLength(body)} challenge=${isChallenge} setCookieCount=${setCookies.length} jarSize=${jar.size}`);
  if (!isChallenge && response.status === 200) {
    console.log("RESULT: PASSED - page reached with cookies.");
    process.exit(0);
  }
}
console.log("RESULT: STILL BLOCKED after cookie retries.");
