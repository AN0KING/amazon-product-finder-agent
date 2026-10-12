import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadSellerSpriteConfig } from "./sellersprite-config.mjs";
import { persistenceStore } from "./persistence-store.mjs";

export const ALLOWED_TOOLS = new Set(["asin_detail", "competitor_lookup"]);

// Official API appendix table 1.2; do not substitute another country's sales.
export const SELLSPRITE_SUPPORTED_MARKETPLACES = Object.freeze(["US", "JP", "UK", "DE", "FR", "IT", "ES", "CA", "IN"]);

const CONNECTION_TIMEOUT = 20_000;
const TOOL_LIST_TIMEOUT = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

let activeClient = null;
let activeTransport = null;
let connectPromise = null;
let manualConnectPromise = null;
let cachedTools = null;
let connectionEpoch = 0;
let toolCallCount = persistenceStore.getTotalToolCallCount();
let sessionToolCallCount = 0;

async function createConnection() {
  const epoch = connectionEpoch;
  const config = await loadSellerSpriteConfig();
  const client = new Client({ name: "scout-amazon-agent", version: "0.4.0" });
  const transport = new StreamableHTTPClientTransport(config.endpoint, {
    requestInit: { headers: config.headers },
    fetch: createSellerSpriteFetch(config.endpoint),
  });

  try {
    await client.connect(transport, {
      timeout: CONNECTION_TIMEOUT,
      maxTotalTimeout: CONNECTION_TIMEOUT,
    });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  if (epoch !== connectionEpoch) {
    await client.close().catch(() => {});
    const error = new Error("SellerSprite connection was superseded.");
    error.code = "CONNECTION_SUPERSEDED";
    throw error;
  }
  activeClient = client;
  activeTransport = transport;
  cachedTools = null;
  return client;
}

export function createSellerSpriteFetch(endpoint, fetchImpl = globalThis.fetch) {
  const configuredEndpoint = new URL(endpoint);
  if (configuredEndpoint.protocol !== "https:") {
    throw sellerSpriteTransportError("SELLSPRITE_REDIRECT_REJECTED", "SellerSprite MCP must use HTTPS.");
  }
  if (typeof fetchImpl !== "function") {
    throw sellerSpriteTransportError("SELLSPRITE_NETWORK_ERROR", "A fetch implementation is unavailable.");
  }

  return async (input, init = undefined) => {
    const request = new Request(input, { ...init, redirect: "manual" });
    assertSellerSpriteRequestUrl(request.url, configuredEndpoint.origin);
    const redirectReplay = request.clone();
    const response = await fetchImpl(request);
    if (!REDIRECT_STATUSES.has(Number(response?.status))) return response;

    await discardResponseBody(response);
    const location = response.headers?.get?.("location");
    if (!location) {
      throw sellerSpriteTransportError(
        "SELLSPRITE_REDIRECT_REJECTED",
        "SellerSprite MCP returned a redirect without a target.",
      );
    }
    const target = new URL(location, request.url);
    assertSellerSpriteRequestUrl(target, configuredEndpoint.origin);

    const redirectedRequest = buildRedirectedRequest(target, redirectReplay, Number(response.status));
    const redirectedResponse = await fetchImpl(redirectedRequest);
    if (REDIRECT_STATUSES.has(Number(redirectedResponse?.status))) {
      await discardResponseBody(redirectedResponse);
      throw sellerSpriteTransportError(
        "SELLSPRITE_REDIRECT_LIMIT",
        "SellerSprite MCP exceeded the one-redirect safety limit.",
      );
    }
    return redirectedResponse;
  };
}

function assertSellerSpriteRequestUrl(value, allowedOrigin) {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "https:" || url.origin !== allowedOrigin) {
    throw sellerSpriteTransportError(
      "SELLSPRITE_REDIRECT_REJECTED",
      "SellerSprite MCP attempted to leave the configured HTTPS origin.",
    );
  }
}

function buildRedirectedRequest(target, request, status) {
  const method = request.method.toUpperCase();
  const switchToGet = status === 303 && method !== "HEAD"
    || (new Set([301, 302]).has(status) && method === "POST");
  if (!switchToGet) return new Request(target, request);

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  return new Request(target, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: request.signal,
  });
}

async function discardResponseBody(response) {
  await response?.body?.cancel?.().catch(() => {});
}

function sellerSpriteTransportError(code, message) {
  const error = new Error(message);
  error.name = "SellerSpriteTransportError";
  error.code = code;
  return error;
}

export function classifySellerSpriteConnectionError(error) {
  const chain = [];
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    seen.add(current);
    chain.push(current);
  }
  const codes = new Set(chain.map((item) => String(item.code || item.name || "").toUpperCase()));
  const statuses = new Set(chain.map((item) => Number(item.status ?? item.data?.status)).filter(Number.isFinite));
  const messages = chain.map((item) => String(item.message || "").toLowerCase()).join(" ");

  if (codes.has("SELLSPRITE_REDIRECT_REJECTED") || codes.has("SELLSPRITE_REDIRECT_LIMIT")) {
    return {
      code: codes.has("SELLSPRITE_REDIRECT_LIMIT") ? "SELLSPRITE_REDIRECT_LIMIT" : "SELLSPRITE_REDIRECT_REJECTED",
      message: "SellerSprite MCP returned an unsafe or excessive redirect. Check the MCP URL in the local SellerSprite configuration.",
    };
  }
  if (statuses.has(401) || statuses.has(403) || [...codes].some((code) => new Set([
    "UNAUTHORIZED",
    "CLIENT_HTTP_AUTHENTICATION",
    "CLIENT_HTTP_FORBIDDEN",
    "SELLSPRITE_AUTH_REQUIRED",
  ]).has(code))) {
    return {
      code: "SELLSPRITE_AUTH_FAILED",
      message: "SellerSprite rejected the configured credential or tool permission.",
    };
  }
  if (codes.has("SELLSPRITE_CONFIG_INVALID") || codes.has("ENOENT") || /codex config|does not contain sellsprite-mcp|does not define/.test(messages)) {
    return {
      code: "SELLSPRITE_CONFIG_INVALID",
      message: "The local SellerSprite MCP configuration is missing or invalid.",
    };
  }
  if (codes.has("ABORTERROR") || codes.has("REQUEST_TIMEOUT") || /timed? out|timeout/.test(messages)) {
    return {
      code: "SELLSPRITE_TIMEOUT",
      message: "SellerSprite MCP did not respond before the connection timeout.",
    };
  }
  if ([...codes].some((code) => /^(?:EAI_AGAIN|ECONN|ENET|ENOTFOUND|EPIPE|ETIMEDOUT|UND_ERR_|CERT_|ERR_TLS)/.test(code))
    || codes.has("TYPEERROR")
    || /fetch failed|dns|socket|network|tls|certificate/.test(messages)) {
    return {
      code: "SELLSPRITE_NETWORK_ERROR",
      message: "SellerSprite MCP could not be reached over HTTPS.",
    };
  }
  return {
    code: "SELLSPRITE_UNAVAILABLE",
    message: "SellerSprite MCP could not complete the connection check.",
  };
}

export async function getSellerSpriteClient() {
  if (activeClient) return activeClient;
  if (!connectPromise) {
    const pending = createConnection().finally(() => {
      if (connectPromise === pending) connectPromise = null;
    });
    connectPromise = pending;
  }
  return connectPromise;
}

export async function listSellerSpriteTools({ refresh = false, signal, timeout = TOOL_LIST_TIMEOUT } = {}) {
  if (cachedTools && !refresh) return cachedTools;
  const client = await getSellerSpriteClient();
  const epoch = connectionEpoch;
  const tools = [];
  let cursor;
  do {
    const response = await client.listTools(
      cursor ? { cursor } : undefined,
      {
        signal,
        timeout,
        maxTotalTimeout: timeout,
        cacheMode: refresh ? "refresh" : "use",
      },
    );
    tools.push(...response.tools);
    cursor = response.nextCursor;
  } while (cursor);
  if (epoch !== connectionEpoch || client !== activeClient) {
    throw sellerSpriteTransportError("CONNECTION_SUPERSEDED", "SellerSprite connection was superseded.");
  }
  cachedTools = tools;
  return tools;
}

export async function connectSellerSprite({ timeout = TOOL_LIST_TIMEOUT } = {}) {
  if (!manualConnectPromise) {
    const action = listSellerSpriteTools({ refresh: true, timeout });
    const trackedAction = action.finally(() => {
      if (manualConnectPromise === trackedAction) manualConnectPromise = null;
    });
    manualConnectPromise = trackedAction;
  }
  return manualConnectPromise;
}

export async function callSellerSpriteTool(name, args, { signal, timeout = 45_000, runId = null } = {}) {
  if (!ALLOWED_TOOLS.has(name)) throw new Error(`SellerSprite tool is not allowed: ${name}`);
  if (signal?.aborted) throw signal.reason || new DOMException("The request was aborted.", "AbortError");
  if (!activeClient || !activeTransport || !cachedTools) {
    const error = new Error("SellerSprite requires an explicit connection click.");
    error.code = "SELLSPRITE_CONNECT_REQUIRED";
    throw error;
  }
  const tools = cachedTools;
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw sellerSpriteTransportError("SELLSPRITE_TOOL_UNAVAILABLE", `SellerSprite tool is unavailable: ${name}`);
  const toolArguments = prepareSellerSpriteToolArguments(name, args, tool.inputSchema);
  if (signal?.aborted) throw signal.reason || new DOMException("The request was aborted.", "AbortError");
  let persisted;
  try {
    persisted = await persistenceStore.recordToolCall({ runId, tool: name });
  } catch (cause) {
    const error = new Error("The local SellerSprite call history could not be saved.");
    error.code = "LOCAL_PERSISTENCE_FAILED";
    error.cause = cause;
    throw error;
  }
  toolCallCount = persisted.total;
  sessionToolCallCount += 1;
  try {
    return await activeClient.callTool({ name, arguments: toolArguments }, { signal, timeout, maxTotalTimeout: timeout });
  } catch (error) {
    if (!signal?.aborted && isConnectionFailure(error)) {
      await resetSellerSpriteClient();
      const sessionError = new Error("SellerSprite authorization session is no longer available.");
      sessionError.code = "SELLSPRITE_SESSION_LOST";
      sessionError.cause = error;
      throw sessionError;
    }
    throw error;
  }
}

export async function resetSellerSpriteClient() {
  connectionEpoch += 1;
  const client = activeClient;
  activeClient = null;
  activeTransport = null;
  cachedTools = null;
  connectPromise = null;
  if (client) await client.close().catch(() => {});
}

function isConnectionFailure(error) {
  const code = String(error?.code || "").toUpperCase();
  if (new Set([
    "NOT_CONNECTED",
    "NOT_INITIALIZED",
    "REQUEST_TIMEOUT",
    "CONNECTION_CLOSED",
    "SEND_FAILED",
    "ERA_NEGOTIATION_FAILED",
    "CLIENT_HTTP_AUTHENTICATION",
    "CLIENT_HTTP_FORBIDDEN",
    "CLIENT_HTTP_FAILED_TO_OPEN_STREAM",
  ]).has(code)) return true;
  const message = String(error?.message || "").toLowerCase();
  return error instanceof TypeError || /fetch failed|connection (?:closed|lost)|socket|network/.test(message);
}

export function getConnectionSummary() {
  return {
    connected: Boolean(activeClient && activeTransport && cachedTools),
    toolCount: cachedTools?.length ?? null,
    tools: cachedTools?.map((tool) => tool.name).filter((name) => typeof name === "string") ?? [],
    toolCallCount,
    sessionToolCallCount,
  };
}

export async function getSellerSpriteConfigurationStatus(options) {
  try {
    await loadSellerSpriteConfig(options);
    return { configured: true, errorCode: null };
  } catch (error) {
    return { configured: false, errorCode: classifySellerSpriteConnectionError(error).code };
  }
}

function toolMarketplaces(tool) {
  const schema = tool?.inputSchema;
  const field = schema?.properties?.marketplace || schema?.properties?.request?.properties?.marketplace;
  const enumeration = field?.enum || (field?.const ? [field.const] : null);
  return enumeration
    ? SELLSPRITE_SUPPORTED_MARKETPLACES.filter((market) => enumeration.includes(market))
    : [...SELLSPRITE_SUPPORTED_MARKETPLACES];
}

export function getSellerSpriteCapabilities(tools = null, marketplace = null) {
  const availableTools = tools || cachedTools || [];
  const market = typeof marketplace === "string" ? marketplace.trim().toUpperCase() : null;
  const capability = (name) => {
    const tool = availableTools.find((item) => item.name === name);
    const supportedMarketplaces = toolMarketplaces(tool);
    return { tool: name, available: Boolean(tool), supportedMarketplaces,
      marketplaceSupported: market ? supportedMarketplaces.includes(market) : null };
  };
  return {
    marketplace: market,
    supportedMarketplaces: [...SELLSPRITE_SUPPORTED_MARKETPLACES],
    marketplaceSupported: market ? SELLSPRITE_SUPPORTED_MARKETPLACES.includes(market) : null,
    detail: capability("asin_detail"),
    monthlySales: { ...capability("competitor_lookup"), sourceField: "amzUnit", period: "past_month", scope: "child_asin" },
    relatedCompetitors: { tool: "asin_competitor", available: availableTools.some((item) => item.name === "asin_competitor"), usedForTargetSales: false },
  };
}

export function prepareSellerSpriteToolArguments(name, args, inputSchema = {}) {
  if (!ALLOWED_TOOLS.has(name)) throw sellerSpriteTransportError("SELLSPRITE_TOOL_UNAVAILABLE", "This SellerSprite tool is not allowed for product collection.");
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw sellerSpriteTransportError("SELLSPRITE_ARGUMENT_INVALID", "SellerSprite arguments must be an object.");
  }
  const payload = args.request && typeof args.request === "object" ? args.request : args;
  const marketplace = String(payload.marketplace || "").trim().toUpperCase();
  if (!toolMarketplaces({ inputSchema }).includes(marketplace)) {
    throw sellerSpriteTransportError("SELLSPRITE_MARKETPLACE_UNSUPPORTED", "SellerSprite does not support sales data for the requested marketplace.");
  }
  const normalized = { ...payload, marketplace };
  delete normalized.returnFields;
  if (name === "asin_detail") {
    normalized.asin = String(payload.asin || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(normalized.asin)) throw sellerSpriteTransportError("SELLSPRITE_ARGUMENT_INVALID", "SellerSprite requires a valid target ASIN.");
  } else {
    if (!Array.isArray(payload.asins) || !payload.asins.length || payload.asins.length > 40
      || payload.asins.some((asin) => typeof asin !== "string" || !/^[A-Z0-9]{10}$/i.test(asin))) {
      throw sellerSpriteTransportError("SELLSPRITE_ARGUMENT_INVALID", "SellerSprite lookup requires between 1 and 40 target ASINs.");
    }
    normalized.asins = payload.asins.map((asin) => asin.toUpperCase());
  }
  const properties = inputSchema?.properties || {};
  const wrapped = Object.hasOwn(properties, "request") || (!Object.hasOwn(properties, "marketplace") && Object.hasOwn(args, "request"));
  const prepared = wrapped ? { request: normalized } : normalized;
  if (Object.hasOwn(args, "returnFields") && (Object.hasOwn(properties, "returnFields") || inputSchema.additionalProperties !== false)) {
    const fields = args.returnFields;
    // Official MCP docs /mcp/46 specify comma-separated names. Keep arrays only
    // when the authenticated tool schema explicitly requires an array.
    prepared.returnFields = Array.isArray(fields) && properties.returnFields?.type !== "array" ? fields.join(",") : fields;
  }
  // A provider may expose the same API as flat or wrapped MCP arguments.
  // Follow its advertised schema; never send a guessed second request.
  for (const key of inputSchema.required || []) {
    if (!Object.hasOwn(prepared, key)) throw sellerSpriteTransportError("SELLSPRITE_SCHEMA_UNSUPPORTED", "SellerSprite requires an unsupported argument; check the tool schema.");
  }
  return prepared;
}
