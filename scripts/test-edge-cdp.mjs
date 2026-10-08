// End-to-end test of the CDP Edge channel: launch, pass the WAF challenge,
// set the AU delivery postcode, verify the JSON acknowledgement.
import process from "node:process";
import { access } from "node:fs/promises";
import { EdgeCdpSession } from "../lib/amazon-edge-cdp.mjs";

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const edgeCandidates = [
  process.env["ProgramFiles(x86)"] && `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  process.env.ProgramFiles && `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
].filter(Boolean);
let resolvedEdge = null;
for (const candidate of edgeCandidates) {
  try {
    await access(candidate);
    resolvedEdge = candidate;
    break;
  } catch {}
}
if (!resolvedEdge) {
  console.log("Edge not found");
  process.exit(1);
}
console.log("edge:", resolvedEdge);
console.log("proxy:", proxyUrl || "(none)");

const session = new EdgeCdpSession({
  edgeExecutable: resolvedEdge,
  proxyUrl,
  language: "en-AU,en;q=0.9",
  requestIntervalMs: 0,
});
try {
  console.log("launching edge...");
  await session.open();
  console.log("navigating to amazon.com.au ...");
  const settled = await session.navigateUntilSettled("https://www.amazon.com.au/", undefined);
  console.log("settled:", JSON.stringify(settled));
  const html = await session.pageHtml();
  console.log("html bytes:", Buffer.byteLength(html, "utf8"));
  console.log("challenge in html:", /AwsWafIntegration|awswaf\.com|challenge-container/i.test(html));
  console.log("posting delivery postcode 3010 ...");
  const response = await session.fetchInPage("https://www.amazon.com.au/gp/delivery/ajax/address-change.html", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: "locationType=LOCATION_INPUT&zipCode=3010&storeContext=generic&pageType=Gateway&actionSource=glow",
  });
  console.log("address-change status:", response.status);
  console.log("address-change body:", String(response.body).slice(0, 400));
  const payload = JSON.parse(response.body);
  const ok = [true, 1, "1"].includes(payload?.isValidAddress)
    && [true, 1, "1"].includes(payload?.isAddressUpdated)
    && [true, 1, "1"].includes(payload?.successful)
    && String(payload?.address?.zipCode) === "3010";
  console.log(ok ? "RESULT: POSTCODE CONFIRMED - CDP channel fully operational." : "RESULT: postcode was not confirmed.");
} catch (error) {
  console.log(`FAILED: ${error?.code || ""} ${error?.message}`);
} finally {
  await session.close();
}
