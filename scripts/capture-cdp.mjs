import { writeFile } from "node:fs/promises";

const [port = "9235", url = "http://127.0.0.1:4173/", output = "qa-cdp.png", widthArg = "390", heightArg = "844", mode = "capture"] = process.argv.slice(2);
const width = Number(widthArg);
const height = Number(heightArg);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((entry) => entry.type === "page");
if (!target?.webSocketDebuggerUrl) throw new Error("No debuggable Edge page was found.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const eventWaiters = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (!waiter) return;
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  const waiters = eventWaiters.get(message.method) || [];
  eventWaiters.delete(message.method);
  waiters.forEach((resolve) => resolve(message.params));
});

function command(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function waitForEvent(method) {
  return new Promise((resolve) => {
    const waiters = eventWaiters.get(method) || [];
    waiters.push(resolve);
    eventWaiters.set(method, waiters);
  });
}

await command("Page.enable");
await command("Runtime.enable");
await command("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: true,
  screenWidth: width,
  screenHeight: height,
});
const loaded = waitForEvent("Page.loadEventFired");
await command("Page.navigate", { url });
await loaded;
await new Promise((resolve) => setTimeout(resolve, 2_000));
const metrics = await command("Runtime.evaluate", {
  expression: `JSON.stringify({innerWidth,innerHeight,scrollWidth:document.documentElement.scrollWidth,actions:(()=>{const r=document.querySelector('.topbar-actions')?.getBoundingClientRect();return r?{left:r.left,right:r.right,width:r.width}:null})()})`,
  returnByValue: true,
});
let smoke = null;
if (mode === "smoke") {
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.result.value;
  };
  await evaluate(`(()=>{const toggle=document.querySelector('[data-filter-enable="limit"]');toggle.checked=true;toggle.dispatchEvent(new Event('change'));document.querySelector('#candidateLimit').value='11';document.querySelector('#startAnalysisButton').click()})()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const invalidLimit = await evaluate(`document.querySelector('#toastMessage').textContent`);
  await evaluate(`(()=>{document.querySelector('#candidateLimit').value='5';document.querySelector('#startAnalysisButton').click()})()`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const uploadLockedDuringRun = await evaluate(`document.querySelector('#storeFileInput').disabled && document.querySelector('#uploadZone').disabled`);
  await new Promise((resolve) => setTimeout(resolve, 650));
  const baseSmoke = await evaluate(`JSON.stringify({
    invalidLimit:${JSON.stringify(invalidLimit)},
    uploadLockedDuringRun:${JSON.stringify(uploadLockedDuringRun)},
    uploadUnlockedAfterRun:!document.querySelector('#storeFileInput').disabled&&!document.querySelector('#uploadZone').disabled,
    progressErrorVisible:!document.querySelector('#progressError').hidden,
    progressErrorTitle:document.querySelector('#progressErrorTitle').textContent,
    candidateMax:document.querySelector('#candidateLimit').max,
    priceLabel:[...document.querySelectorAll('.filter-line>span')].some(element=>element.textContent.includes('当前售价区间')),
    productCount:document.querySelector('#navCandidateCount').textContent
  })`);
  await evaluate(`document.querySelector('#useDemoDataButton').click()`);
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  const demoCount = await evaluate(`document.querySelector('#navCandidateCount').textContent`);
  await evaluate(`(async()=>{const blob=await fetch('/index.html').then(response=>response.blob());const file=new File([blob],'broken.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('#storeFileInput');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const importReset = await evaluate(`JSON.stringify({demoCount:${JSON.stringify(demoCount)},productCount:document.querySelector('#navCandidateCount').textContent,importStatus:document.querySelector('#importStatusLabel span')?.textContent,history:document.querySelector('#historySummary')?.textContent})`);
  smoke = JSON.stringify({ ...JSON.parse(baseSmoke), ...JSON.parse(importReset) });
}
const screenshot = await command("Page.captureScreenshot", { format: "png", fromSurface: true });
await writeFile(output, Buffer.from(screenshot.data, "base64"));
process.stdout.write(`${JSON.stringify({ metrics: JSON.parse(metrics.result.value), smoke: smoke ? JSON.parse(smoke) : null })}\n`);
socket.close();
