// Dump the actual response body for challenge analysis.
import "../lib/fetch-proxy.mjs";

const target = process.argv[2] || "https://www.amazon.com.au";
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
  console.log(`status: ${response.status}`);
  console.log("--- BODY START ---");
  console.log(body.slice(0, 3000));
  console.log("--- BODY END ---");
} catch (error) {
  console.log(`request failed: ${error?.cause?.code || error?.code || error?.message}`);
}
