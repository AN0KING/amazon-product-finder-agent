import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSellerSpriteConfig } from "../lib/sellersprite-config.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "scout-sellersprite-test-"));
const previousDataDirectory = process.env.SCOUT_DATA_DIR;
process.env.SCOUT_DATA_DIR = path.join(directory, "state");
const { getSellerSpriteCapabilities, getSellerSpriteConfigurationStatus, prepareSellerSpriteToolArguments,
  classifySellerSpriteConnectionError, createSellerSpriteFetch, callSellerSpriteTool, getConnectionSummary,
  connectSellerSprite, resetSellerSpriteClient,
} = await import("../lib/sellsprite-client.mjs");
const { persistenceStore } = await import("../lib/persistence-store.mjs");
await persistenceStore.readyPromise;
if (previousDataDirectory === undefined) delete process.env.SCOUT_DATA_DIR;
else process.env.SCOUT_DATA_DIR = previousDataDirectory;
after(() => rm(directory, { recursive: true, force: true }));

let sequence = 0;
async function configuration(source, env = {}) {
  const configPath = path.join(directory, `config-${++sequence}.toml`);
  await writeFile(configPath, source);
  return { configPath, env };
}
const headerConfig = (name = "sellsprite-mcp", body = 'http_headers = { "secret-key" = "synthetic-only-secret" }') =>
  `[mcp_servers.${name}]\nurl = "https://mcp.example.test/mcp"\n${body}\n`;

test("configuration accepts both established and correctly spelled server names", async () => {
  for (const name of ["sellsprite-mcp", "sellersprite-mcp"]) {
    const config = await loadSellerSpriteConfig(await configuration(headerConfig(name)));
    assert.equal(config.name, name);
    assert.equal(config.headers["secret-key"], "synthetic-only-secret");
  }
});

test("official-style server names without an mcp suffix are recognized by the loader and status", async () => {
  for (const name of ["sellersprite", "sellsprite"]) {
    const options = await configuration(headerConfig(name) + 'enabled = true\n');
    const config = await loadSellerSpriteConfig(options);
    assert.equal(config.name, name);
    assert.equal(config.endpoint.href, "https://mcp.example.test/mcp");
    assert.deepEqual(config.headers, { "secret-key": "synthetic-only-secret" });
    assert.deepEqual(await getSellerSpriteConfigurationStatus(options), { configured: true, errorCode: null });
  }
});

test("multiple enabled SellerSprite aliases are rejected instead of selecting a credential", async () => {
  const aliases = ["sellsprite-mcp", "sellersprite-mcp", "sellersprite", "sellsprite"];
  for (let left = 0; left < aliases.length; left += 1) {
    for (let right = left + 1; right < aliases.length; right += 1) {
      const source = headerConfig(aliases[left]) + 'enabled = true\n'
        + headerConfig(aliases[right]) + 'enabled = true\n';
      await assert.rejects(loadSellerSpriteConfig(await configuration(source)), {
        code: "SELLSPRITE_CONFIG_INVALID",
        message: "Multiple SellerSprite MCP configurations are ambiguous.",
      });
    }
  }
});

test("unrelated or merely similar MCP server names cannot supply SellerSprite credentials", async () => {
  for (const name of ["other-provider", "custom-sellersprite-mcp", "sellersprite-backup", "SellerSprite"]) {
    const unrelated = headerConfig(name, 'http_headers = { "secret-key" = "unrelated-synthetic-secret" }');
    await assert.rejects(loadSellerSpriteConfig(await configuration(unrelated)), { code: "SELLSPRITE_CONFIG_INVALID" });
    const config = await loadSellerSpriteConfig(await configuration(unrelated + headerConfig("sellersprite")));
    assert.equal(config.name, "sellersprite");
    assert.equal(config.headers["secret-key"], "synthetic-only-secret");
  }
});

test("environment headers and bearer variables are resolved without persisting secrets", async () => {
  const config = await loadSellerSpriteConfig(await configuration(headerConfig("sellersprite-mcp",
    'env_http_headers = { "secret-key" = "TEST_SECRET" }\nbearer_token_env_var = "TEST_BEARER"'),
  { TEST_SECRET: "from-env", TEST_BEARER: "env-bearer" }));
  assert.equal(config.headers["secret-key"], "from-env");
  assert.equal(config.headers.authorization, "Bearer env-bearer");
});

test("missing environment values, disabled entries and ambiguous names fail clearly", async () => {
  for (const source of [
    headerConfig("sellsprite-mcp", 'env_http_headers = { "secret-key" = "ABSENT" }'),
    headerConfig("sellsprite-mcp", 'bearer_token_env_var = "ABSENT"'),
    headerConfig() + 'enabled = false\n',
    headerConfig("sellersprite") + 'enabled = false\n',
    headerConfig("sellsprite") + 'enabled = false\n',
    headerConfig() + headerConfig("sellersprite-mcp"),
  ]) {
    await assert.rejects(loadSellerSpriteConfig(await configuration(source)), { code: "SELLSPRITE_CONFIG_INVALID" });
  }
});

test("configuration diagnostic stays local and reveals neither path nor credentials", async () => {
  const options = await configuration(headerConfig());
  assert.deepEqual(await getSellerSpriteConfigurationStatus(options), { configured: true, errorCode: null });
  assert.deepEqual(await getSellerSpriteConfigurationStatus(await configuration("[broken\nsecret-key='do-not-reveal'")),
    { configured: false, errorCode: "SELLSPRITE_CONFIG_INVALID" });
});

test("malformed TOML, invalid endpoints and absent credentials never expose source values", async () => {
  for (const source of ["[broken\nsecret-key='do-not-reveal'", headerConfig().replace("https://mcp.example.test/mcp", "not-a-url-do-not-reveal"),
    headerConfig().replace("https:", "http:"), headerConfig().replace("mcp.example.test", "user:do-not-reveal@mcp.example.test"),
    headerConfig("sellsprite-mcp", 'http_headers = { "Accept" = "application/json" }')]) {
    await assert.rejects(loadSellerSpriteConfig(await configuration(source)), (error) => {
      assert.equal(error.code, "SELLSPRITE_CONFIG_INVALID");
      assert.doesNotMatch(error.message, /do-not-reveal/);
      return true;
    });
  }
});

test("official market table is enforced even if a provider advertises AU or NL", () => {
  const tools = [{ name: "asin_detail", inputSchema: { properties: { marketplace: { enum: ["US", "AU", "NL"] } } } },
    { name: "competitor_lookup", inputSchema: { properties: { request: { properties: { marketplace: { enum: ["US", "CA", "AU"] } } } } } }];
  const capabilities = getSellerSpriteCapabilities(tools, "AU");
  assert.equal(capabilities.marketplaceSupported, false);
  assert.deepEqual(capabilities.detail.supportedMarketplaces, ["US"]);
  assert.deepEqual(capabilities.monthlySales.supportedMarketplaces, ["US", "CA"]);
  assert.equal(capabilities.monthlySales.marketplaceSupported, false);
  assert.equal(getSellerSpriteCapabilities(tools, "NL").marketplaceSupported, false);
});

test("detail and related-competitor availability do not claim target monthly sales", () => {
  const capabilities = getSellerSpriteCapabilities([{ name: "asin_detail" }, { name: "asin_competitor" }], "CA");
  assert.equal(capabilities.detail.available, true);
  assert.equal(capabilities.monthlySales.available, false);
  assert.equal(capabilities.relatedCompetitors.usedForTargetSales, false);
  assert.equal(capabilities.monthlySales.sourceField, "amzUnit");
  assert.equal(capabilities.monthlySales.scope, "child_asin");
  assert.equal(capabilities.monthlySales.period, "past_month");
});

const request = { marketplace: "CA", asins: ["B000000001"], month: "nearly", variation: "N", page: 1, size: 1 };
test("lookup follows flat or wrapped advertised schema without a second request", () => {
  const wrapped = { type: "object", properties: { request: { type: "object" }, returnFields: { type: "array" } }, required: ["request"] };
  const flat = { type: "object", properties: { marketplace: {}, asins: {}, returnFields: {} }, required: ["marketplace", "asins"] };
  assert.deepEqual(prepareSellerSpriteToolArguments("competitor_lookup", { request, returnFields: ["asin", "amzUnit"] }, wrapped),
    { request, returnFields: ["asin", "amzUnit"] });
  assert.deepEqual(prepareSellerSpriteToolArguments("competitor_lookup", { request, returnFields: ["asin", "amzUnit"] }, flat),
    { ...request, returnFields: "asin,amzUnit" });
  assert.deepEqual(prepareSellerSpriteToolArguments("competitor_lookup", { ...request, returnFields: ["asin"] }, wrapped),
    { request, returnFields: ["asin"] });
});

test("official comma-separated returnFields is used for a string or unspecified schema", () => {
  for (const inputSchema of [{}, { properties: { request: {}, returnFields: { type: "string" } } }]) {
    assert.equal(prepareSellerSpriteToolArguments("competitor_lookup", { request, returnFields: ["asin", "amzUnit"] }, inputSchema).returnFields, "asin,amzUnit");
  }
});

test("schema with closed properties does not receive unsupported returnFields", () => {
  const schema = { properties: { marketplace: {}, asin: {} }, additionalProperties: false };
  assert.deepEqual(prepareSellerSpriteToolArguments("asin_detail", { marketplace: "ca", asin: "b000000001", returnFields: ["asin"] }, schema),
    { marketplace: "CA", asin: "B000000001" });
});

test("AU and NL are rejected locally instead of using another country's sales", () => {
  for (const marketplace of ["AU", "NL"]) {
    assert.throws(() => prepareSellerSpriteToolArguments("asin_detail", { marketplace, asin: "B000000001" }),
      { code: "SELLSPRITE_MARKETPLACE_UNSUPPORTED" });
  }
});

test("invalid target ASINs, over-limit batches and the unrelated competitor tool fail locally", () => {
  assert.throws(() => prepareSellerSpriteToolArguments("asin_competitor", { marketplace: "US", asin: "B000000001" }),
    { code: "SELLSPRITE_TOOL_UNAVAILABLE" });
  assert.throws(() => prepareSellerSpriteToolArguments("asin_detail", { marketplace: "US", asin: "bad" }),
    { code: "SELLSPRITE_ARGUMENT_INVALID" });
  for (const asins of [[], ["bad"], Array(41).fill("B000000001")]) {
    assert.throws(() => prepareSellerSpriteToolArguments("competitor_lookup", { request: { ...request, asins } }),
      { code: "SELLSPRITE_ARGUMENT_INVALID" });
  }
});

test("unknown required provider arguments fail before any billable call", () => {
  assert.throws(() => prepareSellerSpriteToolArguments("competitor_lookup", { request }, { required: ["unsupported"] }),
    { code: "SELLSPRITE_SCHEMA_UNSUPPORTED" });
});

test("business tool calls still require an explicit connection and do not increment calls", async () => {
  const before = getConnectionSummary().toolCallCount;
  await assert.rejects(callSellerSpriteTool("asin_detail", { marketplace: "US", asin: "B000000001" }),
    { code: "SELLSPRITE_CONNECT_REQUIRED" });
  assert.equal(getConnectionSummary().toolCallCount, before);
});

test("explicit reconnect refreshes tool permissions while sharing the session and concurrent clicks", { timeout: 5000 }, async (t) => {
  const { configPath } = await configuration(headerConfig("sellersprite"));
  const previousConfigPath = process.env.SCOUT_SELLERSPRITE_CONFIG_PATH;
  const requests = [];
  const sessionHeaders = [];
  const tool = (name) => ({ name, inputSchema: { type: "object", properties: {} } });
  let offeredTools = [tool("asin_competitor")];
  await resetSellerSpriteClient();
  const before = getConnectionSummary();
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(request.url, "https://mcp.example.test/mcp");
    if (request.method === "GET") return new Response(null, { status: 405 });
    assert.equal(request.method, "POST");
    const message = await request.json();
    requests.push(message.method);
    const reply = (result, headers = {}) => Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers });
    if (message.method === "server/discover") {
      return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Legacy MCP fixture" } });
    }
    if (message.method === "initialize") {
      return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: "synthetic-sellersprite", version: "1.0.0" } }, { "mcp-session-id": "synthetic-session" });
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") {
      sessionHeaders.push(request.headers.get("mcp-session-id"));
      await new Promise((resolve) => setImmediate(resolve));
      return reply({ tools: offeredTools });
    }
    assert.fail(`Unexpected MCP method during connection check: ${message.method}`);
  });
  process.env.SCOUT_SELLERSPRITE_CONFIG_PATH = configPath;
  try {
    const first = await Promise.all([connectSellerSprite({ timeout: 1000 }), connectSellerSprite({ timeout: 1000 })]);
    assert.deepEqual(first.map((tools) => tools.map(({ name }) => name)), [["asin_competitor"], ["asin_competitor"]]);
    assert.equal(getSellerSpriteCapabilities(null, "CA").monthlySales.available, false);
    assert.equal(requests.filter((method) => method === "initialize").length, 1);
    assert.equal(requests.filter((method) => method === "tools/list").length, 1);

    offeredTools = [tool("asin_competitor"), tool("competitor_lookup")];
    const refreshed = await Promise.all([
      connectSellerSprite({ timeout: 1000 }), connectSellerSprite({ timeout: 1000 }), connectSellerSprite({ timeout: 1000 }),
    ]);
    assert.deepEqual(refreshed.map((tools) => tools.map(({ name }) => name)), Array(3).fill(["asin_competitor", "competitor_lookup"]));
    assert.equal(getSellerSpriteCapabilities(null, "CA").monthlySales.available, true);
    assert.deepEqual(getConnectionSummary().tools, ["asin_competitor", "competitor_lookup"]);
    assert.equal(requests.filter((method) => method === "initialize").length, 1);
    assert.equal(requests.filter((method) => method === "tools/list").length, 2);
    assert.deepEqual(sessionHeaders, ["synthetic-session", "synthetic-session"]);
    assert.equal(requests.includes("tools/call"), false);
    assert.equal(getConnectionSummary().toolCallCount, before.toolCallCount);
    assert.equal(getConnectionSummary().sessionToolCallCount, before.sessionToolCallCount);
  } finally {
    await resetSellerSpriteClient();
    if (previousConfigPath === undefined) delete process.env.SCOUT_SELLERSPRITE_CONFIG_PATH;
    else process.env.SCOUT_SELLERSPRITE_CONFIG_PATH = previousConfigPath;
  }
});

test("transport refuses cross-origin redirects without forwarding authentication", async () => {
  const urls = [];
  const fetchImpl = async (request) => { urls.push(request.url); return new Response(null,
    { status: 302, headers: { location: "https://unrelated.example.test/" } }); };
  const fetch = createSellerSpriteFetch("https://mcp.example.test/mcp", fetchImpl);
  await assert.rejects(fetch("https://mcp.example.test/mcp", { headers: { "secret-key": "synthetic" } }),
    { code: "SELLSPRITE_REDIRECT_REJECTED" });
  assert.deepEqual(urls, ["https://mcp.example.test/mcp"]);
});

test("connection errors distinguish local configuration from remote authentication and network", () => {
  assert.equal(classifySellerSpriteConnectionError({ code: "SELLSPRITE_CONFIG_INVALID", message: "disabled" }).code, "SELLSPRITE_CONFIG_INVALID");
  assert.equal(classifySellerSpriteConnectionError({ status: 401 }).code, "SELLSPRITE_AUTH_FAILED");
  assert.equal(classifySellerSpriteConnectionError({ cause: { code: "ECONNRESET" } }).code, "SELLSPRITE_NETWORK_ERROR");
});
