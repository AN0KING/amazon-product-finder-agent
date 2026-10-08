import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

const AMAZON_IMAGE_HOSTS = new Set([
  "m.media-amazon.com",
  "images-na.ssl-images-amazon.com",
  "images-eu.ssl-images-amazon.com",
  "images-fe.ssl-images-amazon.com",
  "images-cn.ssl-images-amazon.com",
]);
const SUPPLIER_IMAGE_HOST_SUFFIXES = ["alicdn.com", "1688.com"];
const DEFAULT_IMAGE_LIMIT = 5 * 1024 * 1024;
const DEFAULT_CANDIDATE_IMAGE_TIMEOUT_MS = 12_000;
const ALLOWED_IMAGE_TYPES = new Map([
  ["image/jpeg", { extension: ".jpg", signature: isJpeg }],
  ["image/png", { extension: ".png", signature: isPng }],
  ["image/webp", { extension: ".webp", signature: isWebp }],
]);

export class SupplierImageError extends Error {
  constructor(code, message, status = 422, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "SupplierImageError";
    this.code = code;
    this.status = status;
  }
}

export async function downloadAllowedProductImage(value, {
  fetchImpl = globalThis.fetch,
  lookupHost = lookupPublicAddresses,
  signal,
  maxBytes = DEFAULT_IMAGE_LIMIT,
  temporaryRoot = os.tmpdir(),
} = {}) {
  const url = requireAmazonImageUrl(value);
  validateByteLimit(maxBytes, "INVALID_IMAGE_LIMIT", "图片大小上限配置无效。");
  await assertPublicHost(url, lookupHost, signal, {
    lookupCode: "IMAGE_DNS_FAILED",
    lookupMessage: "无法验证商品图片所在的网络地址。",
    privateCode: "IMAGE_HOST_NOT_PUBLIC",
    privateMessage: "商品图片地址没有解析到可公开访问的网络地址。",
  });
  const { buffer, mimeType, type } = await downloadImage(url, {
    fetchImpl,
    signal,
    maxBytes,
    prefix: "IMAGE",
    label: "商品图片",
  });

  const directory = await mkdtemp(path.join(path.resolve(temporaryRoot), "scout-1688-image-"));
  const filePath = path.join(directory, `product${type.extension}`);
  try {
    await writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
  } catch (cause) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw new SupplierImageError("IMAGE_TEMP_WRITE_FAILED", "无法准备 1688 搜图临时文件。", 500, cause);
  }
  let cleaned = false;
  return {
    path: filePath,
    mimeType,
    size: buffer.length,
    sha256: sha256(buffer),
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function toOriginalAmazonImageUrl(value) {
  const url = requireAmazonImageUrl(value);
  const transformedPath = /^(\/images\/I\/.+?)\._[^/]+_\.(jpe?g|png|webp)$/i.exec(url.pathname);
  if (!transformedPath) return url.href;
  url.pathname = `${transformedPath[1]}.${transformedPath[2].toLowerCase()}`;
  return url.href;
}

export async function downloadAllowedSupplierImage(value, {
  fetchImpl = globalThis.fetch,
  lookupHost = lookupPublicAddresses,
  signal,
  maxBytes = DEFAULT_IMAGE_LIMIT,
  timeoutMs = DEFAULT_CANDIDATE_IMAGE_TIMEOUT_MS,
} = {}) {
  const url = requireSupplierImageUrl(value);
  validateByteLimit(maxBytes, "INVALID_CANDIDATE_IMAGE_LIMIT", "1688 候选图片大小上限配置无效。");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new SupplierImageError("INVALID_CANDIDATE_IMAGE_TIMEOUT", "1688 候选图片超时配置无效。", 500);
  }
  await assertPublicHost(url, lookupHost, signal, {
    lookupCode: "CANDIDATE_IMAGE_DNS_FAILED",
    lookupMessage: "无法验证 1688 候选图片所在的网络地址。",
    privateCode: "CANDIDATE_IMAGE_HOST_NOT_PUBLIC",
    privateMessage: "1688 候选图片没有解析到可公开访问的网络地址。",
  });
  const requestSignal = combineSignals(signal, timeoutMs);
  const { buffer, mimeType } = await downloadImage(url, {
    fetchImpl,
    signal: requestSignal,
    maxBytes,
    prefix: "CANDIDATE_IMAGE",
    label: "1688 候选图片",
  });
  return {
    url: url.href,
    buffer,
    mimeType,
    size: buffer.length,
    sha256: sha256(buffer),
  };
}

async function downloadImage(url, { fetchImpl, signal, maxBytes, prefix, label }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "image/jpeg,image/png,image/webp" },
      redirect: "manual",
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw signal.reason || cause;
    throw new SupplierImageError(`${prefix}_DOWNLOAD_FAILED`, `无法下载${label}。`, 502, cause);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new SupplierImageError(`${prefix}_REDIRECT_FORBIDDEN`, `${label}发生跳转，已按安全规则拒绝。`, 422);
  }
  if (!response.ok) {
    throw new SupplierImageError(`${prefix}_DOWNLOAD_FAILED`, `${label}下载失败（HTTP ${response.status}）。`, 502);
  }
  if (response.url) {
    const finalUrl = prefix === "IMAGE" ? requireAmazonImageUrl(response.url) : requireSupplierImageUrl(response.url);
    if (finalUrl.href !== url.href) {
      throw new SupplierImageError(`${prefix}_REDIRECT_FORBIDDEN`, `${label}最终地址与请求地址不一致。`, 422);
    }
  }

  const mimeType = String(response.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  const type = ALLOWED_IMAGE_TYPES.get(mimeType);
  if (!type) {
    throw new SupplierImageError(`${prefix}_TYPE_FORBIDDEN`, `${label}必须是 JPEG、PNG 或 WebP 格式。`, 415);
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw imageTooLarge(prefix, label, maxBytes);
  }
  const buffer = await readResponseBodyLimited(response, maxBytes, signal, prefix, label);
  if (!buffer.length || !type.signature(buffer)) {
    throw new SupplierImageError(`${prefix}_SIGNATURE_INVALID`, `${label}内容与声明格式不一致。`, 415);
  }
  return { buffer, mimeType, type };
}

async function assertPublicHost(url, lookupHost, signal, messages) {
  let addresses;
  try {
    addresses = await lookupHost(url.hostname, { signal });
  } catch (cause) {
    throw new SupplierImageError(messages.lookupCode, messages.lookupMessage, 502, cause);
  }
  if (!Array.isArray(addresses) || !addresses.length
    || addresses.some((entry) => !isPublicIp(entry?.address || entry))) {
    throw new SupplierImageError(messages.privateCode, messages.privateMessage, 422);
  }
}

function requireAmazonImageUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (_) {
    throw new SupplierImageError("INVALID_IMAGE_URL", "Amazon 商品图片地址无效。");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !AMAZON_IMAGE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new SupplierImageError("IMAGE_URL_FORBIDDEN", "商品图片只允许来自已批准的 Amazon HTTPS 图片域名。", 422);
  }
  url.hash = "";
  return url;
}

function requireSupplierImageUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (_) {
    throw new SupplierImageError("INVALID_CANDIDATE_IMAGE_URL", "1688 候选商品图片地址无效。");
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = SUPPLIER_IMAGE_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed) {
    throw new SupplierImageError("CANDIDATE_IMAGE_URL_FORBIDDEN", "1688 候选图片只允许来自已批准的阿里 HTTPS 图片域名。", 422);
  }
  url.hash = "";
  return url;
}

async function lookupPublicAddresses(hostname) {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

function isPublicIp(value) {
  const address = String(value || "").toLowerCase().split("%", 1)[0];
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const words = parseIpv6Words(address);
  if (!words) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] <= 1) return false;
  if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00) return false;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPublicIpv4(`${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`);
  }
  return !words.slice(0, 6).every((word) => word === 0);
}

function isPublicIpv4(value) {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c <= 2) return false;
  if (a === 198 && [18, 19, 51].includes(b)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6Words(value) {
  let text = value;
  if (text.includes(".")) {
    const lastSeparator = text.lastIndexOf(":");
    const octets = text.slice(lastSeparator + 1).split(".").map(Number);
    if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return null;
    text = `${text.slice(0, lastSeparator)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    .map((word) => Number.parseInt(word || "0", 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

async function readResponseBodyLimited(response, maxBytes, signal, prefix, label) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) throw imageTooLarge(prefix, label, maxBytes);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, total);
    } finally {
      reader.releaseLock?.();
    }
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw imageTooLarge(prefix, label, maxBytes);
  return buffer;
}

function validateByteLimit(value, code, message) {
  if (!Number.isInteger(value) || value < 1 || value > 20 * 1024 * 1024) {
    throw new SupplierImageError(code, message, 500);
  }
}

function imageTooLarge(prefix, label, maxBytes) {
  return new SupplierImageError(`${prefix}_TOO_LARGE`, `${label}超过 ${maxBytes} 字节上限。`, 413);
}

function combineSignals(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("The operation was aborted.", "AbortError");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isPng(buffer) {
  return buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isWebp(buffer) {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}
