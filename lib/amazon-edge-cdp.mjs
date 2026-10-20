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
import { detectAmazonAccessPage } from "./amazon-access-page.mjs";

const NAVIGATION_TIMEOUT_MS = 45_000;
const CHALLENGE_SETTLE_TIMEOUT_MS = 40_000;
const CHALLENGE_POLL_INTERVAL_MS = 500;
const COMMAND_TIMEOUT_MS = 30_000;
const PRODUCT_INFORMATION_TIMEOUT_MS = 12_000;
const PRODUCT_INFORMATION_POLL_MS = 200;
const PRODUCT_INFORMATION_STABLE_MS = 2_000;


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
      waiter.cleanup?.();
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

  command(method, params = {}, { signal, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    if (this.closed || !this.socket) {
      return Promise.reject(new EdgeCdpError("EDGE_CDP_CLOSED", "Edge CDP session is not open."));
    }
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    const id = ++this.nextCommandId;
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const fail = error => {
        clearTimeout(timer);
        cleanup();
        this.pendingCommands.delete(id);
        reject(error);
      };
      const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      const timer = setTimeout(() => fail(new EdgeCdpError("EDGE_CDP_TIMEOUT", `CDP command ${method} timed out.`)), timeoutMs);
      this.pendingCommands.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { fail(error); }
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
    let lastState = null;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const state = await this.inspectPage();
      lastState = state;
      currentUrl = state.url || currentUrl;
      if (!state.challenge && state.readyState === "complete" && state.byteLength > 0) {
        return { url: currentUrl, byteLength: state.byteLength };
      }
      await delay(CHALLENGE_POLL_INTERVAL_MS, signal);
    }
    if (lastState?.challenge === true) {
      throw new EdgeCdpError("EDGE_CDP_CHALLENGE_TIMEOUT", `Amazon access verification remains visible (${lastState.reason || "verification_page"}).`);
    }
    throw new EdgeCdpError("EDGE_CDP_NAVIGATION_TIMEOUT", "Amazon browser page did not finish loading; no access verification was confirmed.");
  }

  async inspectPage() {
    const result = await this.command("Runtime.evaluate", {
      expression: "JSON.stringify({readyState:document.readyState,url:location.href,title:document.title,html:document.documentElement.outerHTML})",
      returnByValue: true,
    });
    try {
      const { html, ...state } = JSON.parse(result.result.value);
      if (typeof html !== "string") throw new Error("Page HTML unavailable");
      return { ...state, byteLength: html.length, ...detectAmazonAccessPage(html) };
    } catch {
      return { readyState: "loading", url: null, title: "", byteLength: 0, challenge: false, reason: "inspection_unavailable" };
    }
  }

  // This inspects the existing product tab only. It never navigates, opens
  // authentication, or touches a challenge. Call once only when parsing found
  // a missing weight or first-available date. Every observed panel is visited,
  // with a fixed time/action budget and a stable DOM check before absence.
  async inspectProductInformation(asin, { signal, expectedOrigin = null } = {}) {
    asin = String(asin || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new EdgeCdpError("EDGE_CDP_INVALID_ASIN", "Product information requires a valid ASIN.");
    const startedAt = Date.now();
    const deadline = startedAt + PRODUCT_INFORMATION_TIMEOUT_MS;
    let scrolled = false;
    let expanded = 0;
    let last = null;
    const preparedSelectors = [];
    const clickedSelectors = [];
    const finish = (state, stable = false) => {
      const { signature, ...publicState } = state;
      return { ...publicState, version: 3, scrolled, expanded, stable, elapsedMs: Date.now() - startedAt };
    };
    const inspect = async action => {
      throwIfAborted(signal);
      const result = await this.command("Runtime.evaluate", {
        expression: `(${inspectProductInformationDom.toString()})(${JSON.stringify({ asin, action, preparedSelectors, clickedSelectors, expectedOrigin })})`,
        returnByValue: true,
      }, { signal, timeoutMs: Math.max(1, deadline - Date.now()) });
      throwIfAborted(signal);
      if (result?.exceptionDetails || !result?.result?.value || typeof result.result.value !== "object") {
        throw new EdgeCdpError("EDGE_CDP_PRODUCT_INFORMATION_FAILED", "Product information DOM inspection failed.");
      }
      const state = result.result.value;
      scrolled ||= state.scrolled === true;
      expanded += Number(state.expanded) || 0;
      if (state.preparedSelector && !preparedSelectors.includes(state.preparedSelector)) preparedSelectors.push(state.preparedSelector);
      if (state.clickedSelector && !clickedSelectors.includes(state.clickedSelector)) clickedSelectors.push(state.clickedSelector);
      return state;
    };
    try {
      last = await inspect("read");
      if (last.status === "blocked") return finish(last);
      last = await inspect("prepare");
      if (last.status === "blocked") return finish(last);
      let previousSignature = last.signature;
      let stableSince = Date.now();
      while (Date.now() < deadline) {
        await delay(Math.min(PRODUCT_INFORMATION_POLL_MS, Math.max(1, deadline - Date.now())), signal);
        if (Date.now() >= deadline) break;
        const next = await inspect("prepare");
        if (next.signature !== previousSignature || next.expanded || next.preparedSelector) stableSince = Date.now();
        previousSignature = next.signature;
        last = next;
        if (last.status === "blocked") return finish(last);
        if (last.status === "complete" && Date.now() - stableSince >= PRODUCT_INFORMATION_STABLE_MS) return finish(last, true);
      }
    } catch (error) {
      throwIfAborted(signal);
      if (error?.code !== "EDGE_CDP_TIMEOUT") throw error;
    }
    return finish({ ...(last || { asin, rootCount: 0, rowCount: 0 }), status: "incomplete", reason: last?.reason === "root_missing" ? "root_missing" : "inspection_timeout" });
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
      waiter.cleanup?.();
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

// Serialized into Runtime.evaluate; keep this function self-contained.
function inspectProductInformationDom({ asin, action, preparedSelectors = [], clickedSelectors = [], expectedOrigin = null }) {
  const rootSelectors = ["#productDetails_feature_div", "#prodDetails", "#productDetails", "#itemDetails_feature_div",
    "#productFactsDesktop_feature_div", "#productFactsMobile_feature_div", "#productFactsDesktopExpander", "#productFactsMobileExpander",
    "#productDetails_techSpec_section_1", "#productDetails_techSpec_section_2",
    "#productDetails_detailBullets_sections1", "#detailBullets_feature_div", "#detailBulletsWrapper_feature_div",
    "#voyagerAccordian_feature_div .btf-lazy-load-target", "#voyagerAccordian_feature_div #item_details",
    "#voyager-ns-desktop-side-sheet-container #voyager-ns-desktop-side-sheet-main-section"];
  const excludedSelector = '[id*="recommend" i],[id*="sponsored" i],[id*="similar" i],[id*="sims-" i],.a-carousel,[data-component-type="s-search-result"]';
  const normalize = value => String(value || "").normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  let safetyCache = new WeakMap();
  const fromUrl = value => {
    try { return new URL(value, location.href).pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase() || null; }
    catch { return null; }
  };
  const blocked = () => {
    const challenge = document.querySelector('#challenge-container,#captchacharacters,#captchaInput,input[name="cvf_captcha_input"],form[action*="validatecaptcha" i],iframe[src*="captcha" i]')
      || /robot check|verify.*(?:human|identity)|captcha|not a robot/i.test(document.title || "");
    if (challenge) return "access_challenge";
    if (!/^(?:www\.)?amazon\.(?:com(?:\.au|\.mx|\.br|\.be|\.tr)?|ca|co\.uk|co\.jp|de|fr|it|es|nl|in|se|pl|ae|sa|sg|ie)$/i.test(location.hostname)
      || !fromUrl(location.href) || (expectedOrigin && location.origin !== expectedOrigin)) return "product_page_context_mismatch";
    return null;
  };
  const computeSafety = element => {
    if (!element || element.closest(excludedSelector) || element.closest("#voyagerAccordian_feature_div #topHighlight")) return false;
    for (let current = element; current; current = current.parentElement) {
      const className = String(current.getAttribute("class") || "").split(/\s+/)
        .filter(name => current.tagName !== "BODY" || !/^a-aui_template_weblab_cache_\d+-[a-z0-9_-]+$/i.test(name)).join(" ");
      const identity = `${current.id} ${className}`;
      if (current.matches("script, style, template, noscript, [data-hook='review']")
        || /carousel|sponsored|recommend|similarities|comparison|compare|p13n|sp_detail|dp-sims|buyitwith|frequently.?bought|twister|variation|template/i.test(identity)) return false;
      const foldedPanel = current.matches(".a-expander-content") && current.closest(".a-expander-container");
      if (current.hidden || current.matches(".aok-hidden, .a-hidden") || getComputedStyle(current).visibility === "hidden"
        || ((getComputedStyle(current).display === "none" || current.getAttribute("aria-hidden") === "true") && !foldedPanel)) return false;
    }
    return true;
  };
  const safe = element => {
    if (!element) return false;
    if (!safetyCache.has(element)) safetyCache.set(element, computeSafety(element));
    return safetyCache.get(element);
  };
  const disabled = element => {
    for (let current = element; current; current = current.parentElement) {
      if (current.matches('[disabled],[aria-disabled="true"]')) return true;
    }
    return false;
  };
  const localControl = control => {
    const href = normalize(control.getAttribute("href"));
    return !control.closest("form") && control.getAttribute("type")?.toLowerCase() !== "submit"
      && (!href || href.startsWith("#") || /^javascript:\s*void\(0\);?$/i.test(href));
  };
  const isBusy = root => Array.from(root.querySelectorAll('[aria-busy="true"],.a-spinner,.a-loading-spinner,[data-lazy-loaded="false"]'))
    .concat(root.matches('[aria-busy="true"],[data-lazy-loaded="false"]') ? [root] : [])
    .some(element => safe(element) && !element.hidden && getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden");
  const rows = root => {
    const result = [];
    let incomplete = false;
    const add = (element, label, value) => {
      label = normalize(normalize(label).replace(/[:：]$/, ""));
      value = normalize(value);
      if (!label && !value) return;
      if (!label || !value) { incomplete = true; return; }
      result.push({ element, label, value });
    };
    for (const row of root.querySelectorAll("tr")) {
      if (!safe(row)) continue;
      const cells = Array.from(row.children).filter(child => /^(TH|TD)$/.test(child.tagName));
      if (cells.length === 2 && cells.every(cell => safe(cell) && Number(cell.getAttribute("colspan") || 1) === 1 && Number(cell.getAttribute("rowspan") || 1) === 1)) add(row, cells[0].textContent, cells[1].textContent);
      else if (normalize(row.textContent)) incomplete = true;
    }
    for (const item of root.querySelectorAll("li")) {
      if (!safe(item) || item.closest("tr") || item.parentElement?.closest("li")) continue;
      const label = item.querySelector(".a-text-bold, b, strong");
      if (label && safe(label)) add(item, label.textContent, normalize(item.textContent).slice(normalize(label.textContent).length).replace(/^\s*[:：]\s*/, ""));
      else if (normalize(item.textContent) && !item.querySelector("table, li, .a-row")) {
        const match = normalize(item.textContent).match(/^([^:]{1,40}?)\s*:\s*(.+)$/);
        if (match) add(item, match[1], match[2]);
        else incomplete = true;
      }
    }
    for (const term of root.querySelectorAll("dt")) {
      const value = term.nextElementSibling;
      if (safe(term) && value?.tagName === "DD" && safe(value)) add(term, term.textContent, value.textContent);
    }
    for (const row of root.querySelectorAll("[role='row'], .a-row, .a-fixed-left-grid")) {
      if (!safe(row) || row.closest("tr") || row.querySelector("table, [role='row'], .a-row, .a-fixed-left-grid")) continue;
      const cells = Array.from(row.children).filter(cell => cell.matches("[role='cell'], .a-column, .a-fixed-left-grid-col"));
      const spans = Array.from(row.children).filter(cell => cell.tagName === "SPAN");
      if (cells.length === 2 && cells.every(safe)) add(row, cells[0].textContent, cells[1].textContent);
      else if (spans.length === 2 && spans.every(safe) && spans[0].matches(".a-text-bold, [role='rowheader']")) add(row, spans[0].textContent, spans[1].textContent);
      else if (normalize(row.textContent)) incomplete = true;
    }
    return { result, incomplete };
  };
  const selectorFor = element => {
    const parts = [];
    for (let current = element; current; current = current.parentElement) {
      if (/^[A-Za-z][\w-]*$/.test(current.id)) return ["#" + current.id, ...parts].join(" > ");
      const name = current.tagName.toLowerCase();
      const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(child => child.tagName === current.tagName) : [current];
      parts.unshift(`${name}:nth-of-type(${siblings.indexOf(current) + 1})`);
    }
    return parts.join(" > ");
  };
  const controlFor = panel => {
    const container = panel.closest(".a-expander-container");
    if (container) return container.querySelector(".a-expander-header, [data-action='a-expander-toggle']");
    if (panel.tagName === "DETAILS") return panel.querySelector("summary");
    return panel.id ? Array.from(document.querySelectorAll("[aria-controls]")).find(control => control.getAttribute("aria-controls") === panel.id) : null;
  };
  const initialBlock = blocked();
  if (initialBlock) return { asin, url: location.href, status: "blocked", reason: initialBlock, rootCount: 0, rowCount: 0 };
  const specificationEntries = Array.from(document.querySelectorAll('[data-action="open-voyager-ns-desktop-side-sheet"] a,[data-action="open-voyager-ns-desktop-side-sheet"] button'))
    .filter(control => safe(control) && /^see all product specifications$/i.test(normalize(control.textContent)));
  const sideSheet = document.querySelector("#voyager-ns-desktop-side-sheet-container #voyager-ns-desktop-side-sheet-main-section");
  const sideSheetVisible = Boolean(sideSheet && safe(sideSheet));
  const pendingSpecifications = specificationEntries.length > 0 && !sideSheetVisible;
  let roots = [...new Set(rootSelectors.flatMap(selector => Array.from(document.querySelectorAll(selector))))].filter(root => {
    // The empty <a id="productDetails" name="productDetails"> is an in-page
    // destination, not an unloaded panel. Real empty containers still wait.
    const navigationAnchor = root.matches("a[name]") && root.getAttribute("name") === root.id
      && !root.matches("[href],[role],[data-action],[aria-controls],[aria-busy],[data-lazy-loaded]")
      && !root.children.length && !normalize(root.textContent);
    return !navigationAnchor && safe(root);
  });
  const collect = () => {
    const panels = [...new Set(roots.flatMap(root => [root, ...root.querySelectorAll(".a-expander-content, details"),
      ...Array.from(root.querySelectorAll("[aria-controls]")).map(control => document.getElementById(control.getAttribute("aria-controls"))).filter(panel => panel && root.contains(panel))]))].filter(safe);
    const sections = panels.map(root => {
      const control = controlFor(root);
      const closed = Boolean(control && (control.getAttribute("aria-expanded") === "false" || (control.tagName === "SUMMARY" && root.getAttribute("open") === null)));
      const selector = selectorFor(root);
      const parsed = rows(root);
      const unresolvedControl = Array.from(root.querySelectorAll('.a-expander-header[aria-expanded="false"],[data-action="a-expander-toggle"][aria-expanded="false"]'))
        .some(control => safe(control) && !panels.some(panel => controlFor(panel) === control));
      const busy = isBusy(root);
      const prepared = preparedSelectors.includes(selector);
      return { root, control, selector, heading: normalize(control?.textContent || root.querySelector("caption")?.textContent || "Product information"),
        ...parsed, incomplete: parsed.incomplete || unresolvedControl, busy, closed, prepared };
    });
    const allRows = new Set(sections.flatMap(section => section.result.map(row => row.element)));
    const parsedSections = new Map();
    for (const element of allRows) {
      const group = element.closest("table, dl, ul") || element.closest(rootSelectors.join(","));
      if (!group) continue;
      const selector = selectorFor(group);
      parsedSections.set(selector, (parsedSections.get(selector) || 0) + 1);
    }
    const incomplete = pendingSpecifications || sections.some(section => section.busy || section.closed || section.incomplete || !section.result.length || !section.prepared);
    return { sections, state: { asin, url: location.href,
      status: roots.length && !incomplete ? "complete" : "incomplete",
      reason: pendingSpecifications ? "pending_specifications" : !roots.length ? "root_missing" : incomplete ? "pending_details" : null,
      rootCount: roots.length, rowCount: allRows.size,
      specifications: { entryCount: specificationEntries.length, visible: sideSheetVisible, pending: pendingSpecifications,
        disabled: specificationEntries.some(disabled) },
      identityDiagnostics: { policy: "observe_without_rejection", sourceAsin: asin, urlAsin: fromUrl(location.href),
        pageAsin: normalize(document.querySelector("#ASIN")?.value).toUpperCase() || null,
        canonicalAsin: fromUrl(document.querySelector('link[rel="canonical"]')?.getAttribute("href")),
        specificationAsins: [...new Set(sections.flatMap(section => section.result.filter(row => /^asin$/i.test(row.label)).map(row => row.value.toUpperCase())))] },
      parsedSections: [...parsedSections].map(([selector, rowCount]) => ({ selector, rowCount })),
      sections: sections.map(section => ({ selector: section.selector, heading: section.heading, rowCount: section.result.length,
        status: section.busy || section.closed || section.incomplete || !section.result.length || !section.prepared ? "incomplete" : "complete",
        busy: section.busy, closed: section.closed })),
      signature: JSON.stringify([sideSheetVisible, specificationEntries.map(control => [selectorFor(control), disabled(control), clickedSelectors.includes(selectorFor(control))]),
        sections.map(section => [section.selector, section.busy, section.closed, section.prepared, section.incomplete,
          section.result.map(row => [row.label, row.value])])]) } };
  };
  let inspected = collect();
  if (action !== "prepare" || inspected.state.status === "blocked") return inspected.state;
  const priority = section => {
    const label = normalize(section.control?.textContent || section.heading);
    return /^product\s+(?:details|information)$/i.test(label) ? 0
      : /item\s*details/i.test(label) ? 1 : /measurements?/i.test(label) ? 2 : 3;
  };
  const canExpand = section => {
    const control = section.control;
    if (!control || !section.closed || !safe(control) || disabled(control) || !localControl(control)) return false;
    const label = normalize(`${control.textContent} ${control.getAttribute("aria-label") || ""}`);
    const owned = roots.some(root => root.contains(control) && root.contains(section.root))
      || roots.some(root => root === section.root && root.closest("#voyagerAccordian_feature_div")
        && controlFor(root) === control && root.closest(".a-expander-container")?.contains(control));
    return owned && /product|technical|detail|information|specification|measurements?|dimensions?|features?|specs?|style|item|materials?|care|more|afficher|voir|détails|produit|mehr|信息|详情|参数|规格|尺寸|材质|护理|更多/i.test(label)
      && !/buy|cart|checkout|sign.?in|log.?in|account|captcha|verify|wish.?list|购买|购物|登录|验证/i.test(label);
  };
  const section = inspected.sections.filter(section => !section.prepared
    || (canExpand(section) && !clickedSelectors.includes(selectorFor(section.control))))
    .sort((left, right) => left.root.contains(right.root) ? -1 : right.root.contains(left.root) ? 1 : priority(left) - priority(right))[0];
  if (clickedSelectors.length >= 12) return inspected.state;
  if (!section) {
    const entry = pendingSpecifications && specificationEntries.find(control => !disabled(control) && localControl(control)
      && !clickedSelectors.includes(selectorFor(control)));
    if (!entry) return inspected.state;
    const changed = blocked();
    if (changed) return { ...inspected.state, status: "blocked", reason: changed };
    entry.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "instant" });
    safetyCache = new WeakMap();
    const afterScrollBlock = blocked();
    if (afterScrollBlock) return { ...inspected.state, status: "blocked", reason: afterScrollBlock, scrolled: true };
    if (!safe(entry) || disabled(entry) || !localControl(entry)) return { ...inspected.state, scrolled: true };
    entry.click();
    const finalBlock = blocked();
    return { ...inspected.state, ...(finalBlock ? { status: "blocked", reason: finalBlock } : {}),
      scrolled: true, expanded: 1, clickedSelector: selectorFor(entry) };
  }
  if (preparedSelectors.length >= 24) return inspected.state;
  let scrolled = false;
  let expanded = 0;
  const preparedSelector = section.selector;
  const reason = blocked();
  if (reason) return { ...inspected.state, status: "blocked", reason };
  if (typeof section.root.scrollIntoView === "function") {
    section.root.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    scrolled = true;
    safetyCache = new WeakMap();
  }
  const control = section.control;
  if (canExpand(section) && !clickedSelectors.includes(selectorFor(control))) {
    const changed = blocked();
    if (changed) return { ...inspected.state, status: "blocked", reason: changed, scrolled };
    control.click();
    expanded++;
    clickedSelectors.push(selectorFor(control));
    safetyCache = new WeakMap();
  }
  preparedSelectors.push(preparedSelector);
  inspected = collect();
  const finalBlock = blocked();
  return { ...inspected.state, ...(finalBlock ? { status: "blocked", reason: finalBlock } : {}), scrolled, expanded, preparedSelector,
    ...(expanded ? { clickedSelector: selectorFor(control) } : {}) };

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
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
  }
}
