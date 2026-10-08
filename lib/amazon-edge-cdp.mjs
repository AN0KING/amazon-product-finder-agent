// Headless-Edge channel driven through the Chrome DevTools Protocol (CDP).
//
// Why this exists: Amazon's edge protection (AWS WAF) serves a JavaScript
// challenge to automated HTTP clients whose TLS fingerprint or IP reputation
// it does not trust. Node's fetch cannot execute that challenge, so requests
// fail with HTTP 202 challenge pages even through a working proxy. A real
// browser kernel executes the challenge transparently, so this channel
// navigates with headless Edge, waits until the challenge clears, and then
// performs the same in-page POST for the delivery postcode that the fetch
// channel performs, keeping the AU/US requirement that product data must come
// from the session whose delivery region was proven.
//
// Only standard CDP domains are used (Page, Runtime, Storage) plus the
// /json/list HTTP endpoint, matching the approach of scripts/capture-cdp.mjs.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const NAVIGATION_TIMEOUT_MS = 45_000;
const CHALLENGE_SETTLE_TIMEOUT_MS = 40_000;
const CHALLENGE_POLL_INTERVAL_MS = 500;
const COMMAND_TIMEOUT_MS = 30_000;

const CHALLENGE_RE = /awswaf\.com|AwsWafIntegration|challenge-container|window\.gokuProps|validatecaptcha|_sec\/verify|ap\/cvf|robot check|not a robot/i;

export class EdgeCdpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EdgeCdpError";
    this.code = code;
  }
}

export class EdgeCdpSession {
  constructor({ edgeExecutable, temporaryRoot, proxyUrl, language, requestIntervalMs }) {
    this.edgeExecutable = edgeExecutable;
    this.temporaryRoot = temporaryRoot;
    this.proxyUrl = proxyUrl;
    this.language = language || "en";
    this.requestIntervalMs = requestIntervalMs || 0;
    this.process = null;
    this.socket = null;
    this.profileDirectory = null;
    this.debugPort = null;
    this.nextCommandId = 0;
    this.pendingCommands = new Map();
    this.eventWaiters = new Map();
    this.lastRequestAt = 0;
    this.closed = false;
  }

  async open() {
    if (this.process) return;
    this.profileDirectory = await mkdtemp(path.join(this.temporaryRoot || tmpdir(), "scout-edge-cdp-"));
    const argumentsList = [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-quic",
      "--no-first-run",
      "--no-default-browser-check",
      "--metrics-recording-only",
      "--disable-features=msEdgeFirstRunExperience",
      `--user-data-dir=${this.profileDirectory}`,
      `--lang=${String(this.language).split(",")[0]}`,
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "about:blank",
    ];
    if (this.proxyUrl && /^https?:\/\//i.test(this.proxyUrl)) {
      argumentsList.unshift(`--proxy-server=${this.proxyUrl}`);
    }
    this.process = spawn(this.edgeExecutable, argumentsList, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const stderrChunks = [];
    this.process.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    const exitPromise = new Promise((resolve) => {
      this.process.once("exit", (code) => resolve(code));
    });
    exitPromise.settled = false;
    exitPromise.then((value) => {
      exitPromise.settled = true;
      return value;
    });

    // The DevTools endpoint is announced on stderr as
    // "DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>".
    // Newer Edge builds (>= 153) stopped printing that line; they only write
    // the DevToolsActivePort file into the profile directory, so fall back to
    // polling that file when the stderr announcement does not appear.
    const devToolsLine = await waitForDevToolsLine(stderrChunks, exitPromise, 20_000, async () => {
      try {
        const content = await readFile(path.join(this.profileDirectory, "DevToolsActivePort"), "utf8");
        const [portLine, browserPathLine] = content.split(/\r?\n/);
        const port = String(portLine || "").trim();
        if (!/^\d+$/.test(port)) return null;
        return `ws://127.0.0.1:${port}${String(browserPathLine || "").trim() || "/devtools/browser"}`;
      } catch {
        return null;
      }
    });
    this.debugPort = Number(new URL(devToolsLine).port);
    const targets = await fetchPageTarget(this.debugPort);
    await this.connect(targets.webSocketDebuggerUrl);
    await this.command("Page.enable");
    await this.command("Runtime.enable");
  }

  connect(webSocketDebuggerUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketDebuggerUrl);
      const timer = setTimeout(() => {
        socket.close();
        reject(new EdgeCdpError("EDGE_CDP_CONNECT_TIMEOUT", "Edge DevTools socket connection timed out."));
      }, 15_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.addEventListener("message", (event) => this.handleSocketMessage(event));
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new EdgeCdpError("EDGE_CDP_CONNECT_FAILED", "Edge DevTools socket connection failed."));
      }, { once: true });
    });
  }

  handleSocketMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data || "{}"));
    } catch {
      return;
    }
    if (message.id) {
      const waiter = this.pendingCommands.get(message.id);
      if (!waiter) return;
      this.pendingCommands.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new EdgeCdpError("EDGE_CDP_COMMAND_FAILED", String(message.error.message || "CDP command failed.")));
      else waiter.resolve(message.result);
      return;
    }
    const waiters = this.eventWaiters.get(message.method);
    if (!waiters) return;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    }
  }

  command(method, params = {}) {
    if (this.closed || !this.socket) {
      return Promise.reject(new EdgeCdpError("EDGE_CDP_CLOSED", "Edge CDP session is not open."));
    }
    const id = ++this.nextCommandId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new EdgeCdpError("EDGE_CDP_TIMEOUT", `CDP command ${method} timed out.`));
      }, COMMAND_TIMEOUT_MS);
      this.pendingCommands.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.eventWaiters.get(method) || [];
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new EdgeCdpError("EDGE_CDP_TIMEOUT", `CDP event ${method} timed out.`));
      }, timeoutMs);
      const waiter = { resolve, timer };
      const waiters = this.eventWaiters.get(method) || [];
      waiters.push(waiter);
      this.eventWaiters.set(method, waiters);
    });
  }

  async respectRequestInterval(signal) {
    const gap = Date.now() - this.lastRequestAt;
    const wait = this.requestIntervalMs - gap;
    if (wait > 0) await delay(wait, signal);
    this.lastRequestAt = Date.now();
  }

  async navigateUntilSettled(url, signal) {
    await this.respectRequestInterval(signal);
    const loadPromise = this.waitForEvent("Page.loadEventFired", NAVIGATION_TIMEOUT_MS).catch(() => null);
    await this.command("Page.navigate", { url });
    await loadPromise;
    // AWS WAF challenge pages execute JavaScript and reload themselves. Wait
    // until the rendered document is no longer a challenge page.
    const deadline = Date.now() + CHALLENGE_SETTLE_TIMEOUT_MS;
    let currentUrl = url;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const state = await this.inspectPage();
      currentUrl = state.url || currentUrl;
      if (!state.challenge && state.readyState === "complete" && state.byteLength > 0) {
        return { url: currentUrl, byteLength: state.byteLength };
      }
      await delay(CHALLENGE_POLL_INTERVAL_MS, signal);
    }
    throw new EdgeCdpError("EDGE_CDP_CHALLENGE_TIMEOUT", "Edge did not clear the Amazon challenge page in time.");
  }

  async inspectPage() {
    const result = await this.command("Runtime.evaluate", {
      expression: "JSON.stringify({readyState:document.readyState,url:location.href,title:document.title,byteLength:document.documentElement.outerHTML.length,challenge:(!!document.querySelector('#challenge-container')||/AwsWafIntegration|awswaf\\.com|gokuProps|validatecaptcha|robot check/i.test(document.documentElement.outerHTML))})",
      returnByValue: true,
    });
    try {
      return JSON.parse(result.result.value);
    } catch {
      return { readyState: "loading", url: null, title: "", byteLength: 0, challenge: true };
    }
  }

  async pageHtml() {
    const result = await this.command("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    });
    return String(result?.result?.value || "");
  }

  async fetchInPage(url, { method = "GET", headers = {}, body } = {}) {
    const result = await this.command("Runtime.evaluate", {
      expression: `(async()=>{const response=await fetch(${JSON.stringify(url)},${JSON.stringify({ method, headers, body })});return JSON.stringify({status:response.status,body:await response.text()});})()`,
      returnByValue: true,
      awaitPromise: true,
    });
    try {
      return JSON.parse(result.result.value);
    } catch {
      throw new EdgeCdpError("EDGE_CDP_FETCH_FAILED", "In-page fetch returned an unreadable response.");
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pendingCommands.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new EdgeCdpError("EDGE_CDP_CLOSED", "Edge CDP session closed."));
    }
    this.pendingCommands.clear();
    for (const waiters of this.eventWaiters.values()) {
      for (const waiter of waiters) clearTimeout(waiter.timer);
    }
    this.eventWaiters.clear();
    try {
      if (this.socket) {
        this.command("Browser.close").catch(() => {});
        await delay(400);
        this.socket.close();
      }
    } catch {}
    this.socket = null;
    const child = this.process;
    this.process = null;
    if (child && child.exitCode === null) {
      await delay(600);
      try {
        child.kill();
      } catch {}
    }
    const profile = this.profileDirectory;
    this.profileDirectory = null;
    if (profile) {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function waitForDevToolsLine(stderrChunks, exitPromise, timeoutMs, readActivePortFallback = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = Buffer.concat(stderrChunks).toString("utf8");
    const match = text.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) return match[1];
    if (readActivePortFallback) {
      const fallback = await readActivePortFallback();
      if (fallback) return fallback;
    }
    if (exitPromise.settled) break;
    await delay(200);
  }
  const exitCode = await exitPromise;
  throw new EdgeCdpError(
    "EDGE_CDP_LAUNCH_FAILED",
    `Edge did not announce a DevTools endpoint (exit=${exitCode}).`,
  );
}

async function fetchPageTarget(port) {
  const deadline = Date.now() + 15_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) });
      const targets = await response.json();
      const page = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new EdgeCdpError("EDGE_CDP_TARGET_NOT_FOUND", `No debuggable Edge page target appeared (${lastError?.code || lastError?.message || "unknown"}).`);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
  }
}
