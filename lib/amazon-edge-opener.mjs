import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const AMAZON_DOMAINS = new Set([
  "amazon.com.au", "amazon.com", "amazon.nl", "amazon.ca", "amazon.co.uk", "amazon.de",
  "amazon.fr", "amazon.it", "amazon.es", "amazon.pl", "amazon.com.mx", "amazon.com.br",
]);

export class AmazonEdgeOpenError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "AmazonEdgeOpenError";
    this.code = code;
    this.status = status;
  }
}

export function validateAmazonBrowserUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* Rejected below. */ }
  if (typeof value !== "string" || value.length > 8192 || !url
    || /[\u0000-\u0020\u007f]/.test(value)
    || url.protocol !== "https:" || url.username || url.password || url.port
    || !AMAZON_DOMAINS.has(url.hostname.replace(/^www\./, ""))
    || !(/\/(?:dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}(?:\/|$)/i.test(url.pathname)
      || /^\/(?:s|sp)\/?$/.test(url.pathname)
      || /^\/stores(?:\/|$)/.test(url.pathname))) {
    throw new AmazonEdgeOpenError("INVALID_AMAZON_BROWSER_URL", "请使用有效的 Amazon 商品或店铺链接。", 422);
  }
  return value;
}

export async function openAmazonInEdge(value, {
  platform = process.platform,
  environment = process.env,
  statImpl = stat,
  spawnImpl = spawn,
} = {}) {
  const url = validateAmazonBrowserUrl(value);
  if (platform !== "win32") {
    throw new AmazonEdgeOpenError("EDGE_OPEN_NOT_SUPPORTED", "此功能需要 Windows 上的 Microsoft Edge。", 501);
  }
  const candidates = [
    path.win32.join(environment["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.win32.join(environment.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    environment.LOCALAPPDATA && path.win32.join(environment.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  let executable;
  for (const candidate of new Set(candidates)) {
    try { if ((await statImpl(candidate)).isFile()) { executable = candidate; break; } } catch { /* Try the next Edge installation. */ }
  }
  if (!executable) {
    throw new AmazonEdgeOpenError("EDGE_NOT_INSTALLED", "未找到 Microsoft Edge，请先安装 Edge 后重新打开。", 503);
  }
  await new Promise((resolve, reject) => {
    const fail = () => reject(new AmazonEdgeOpenError("EDGE_OPEN_FAILED", "Microsoft Edge 未能打开，请稍后重试。"));
    let child;
    try {
      child = spawnImpl(executable, [url], { detached: true, shell: false, stdio: "ignore", windowsHide: false });
    } catch { fail(); return; }
    child.once("error", fail);
    child.once("spawn", () => { child.unref?.(); resolve(); });
  });
  return { opened: true, browser: "edge" };
}
