import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSellerSpriteConfigPath, loadSellerSpriteConfig } from "../lib/sellersprite-config.mjs";
import { getCodexConfigPath, loadSellerSpriteConfig as compatibilityLoader } from "../lib/codex-mcp-config.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), "scout-independent-config-"));
after(() => rm(directory, { recursive: true, force: true }));
let sequence = 0;
const section = (name = "sellersprite", auth = 'env_http_headers = { "secret-key" = "TEST_SECRET" }') =>
  `[${name}]\nurl = "https://mcp.example.test/mcp"\n${auth}\n`;
async function fixture(source) {
  const configPath = path.join(directory, `standalone-${++sequence}.toml`);
  await writeFile(configPath, source);
  return configPath;
}

function assertPrivateConfigError(error) {
  assert.equal(error.name, "SellerSpriteConfigError");
  assert.equal(error.code, "SELLSPRITE_CONFIG_INVALID");
  assert.doesNotMatch(error.message, /synthetic-secret|sensitive-path|mcp\.example|TEST_SECRET|do-not-reveal/);
  assert.equal(error.cause, undefined);
  return true;
}

test("default configuration belongs to the installation and ignores AI application settings", () => {
  const env = {
    SCOUT_CODEX_CONFIG_PATH: path.join(directory, "legacy-sensitive-path.toml"),
    CODEX_HOME: directory, USERPROFILE: directory, HOME: directory,
  };
  assert.equal(getSellerSpriteConfigPath({ env }), path.join(projectRoot, "config", "sellersprite.local.toml"));
  assert.equal(getCodexConfigPath({ env }), getSellerSpriteConfigPath({ env }));
  assert.equal(compatibilityLoader, loadSellerSpriteConfig);
});

test("changing working directory cannot change default or relative override configuration paths", () => {
  const previous = process.cwd();
  try {
    process.chdir(directory);
    assert.equal(getSellerSpriteConfigPath({ env: {} }), path.join(projectRoot, "config", "sellersprite.local.toml"));
    assert.equal(getSellerSpriteConfigPath({ env: { SCOUT_SELLERSPRITE_CONFIG_PATH: "config/team.local.toml" } }),
      path.join(projectRoot, "config", "team.local.toml"));
  } finally {
    process.chdir(previous);
  }
});

test("a missing standalone file never falls back to valid legacy AI credentials", async () => {
  const fakeHome = path.join(directory, "fake-user");
  await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
  const legacy = path.join(fakeHome, ".codex", "config.toml");
  await writeFile(legacy, section("mcp_servers.sellersprite", 'http_headers = { "secret-key" = "synthetic-secret" }'));
  const env = {
    SCOUT_SELLERSPRITE_CONFIG_PATH: path.join(directory, "not-configured.toml"),
    SCOUT_CODEX_CONFIG_PATH: legacy, USERPROFILE: fakeHome, HOME: fakeHome, CODEX_HOME: path.dirname(legacy),
  };
  await assert.rejects(loadSellerSpriteConfig({ env }), assertPrivateConfigError);
});

test("standalone path environment override and injected authentication environment work", async () => {
  const configPath = await fixture(section());
  const result = await loadSellerSpriteConfig({ env: { SCOUT_SELLERSPRITE_CONFIG_PATH: configPath, TEST_SECRET: "synthetic-secret" } });
  assert.equal(result.name, "sellersprite");
  assert.equal(result.configPath, configPath);
  assert.equal(result.endpoint.href, "https://mcp.example.test/mcp");
  assert.deepEqual(result.headers, { "secret-key": "synthetic-secret" });
});

test("explicit file injection takes precedence over the environment path", async () => {
  const configPath = await fixture(section("sellersprite", 'http_headers = { "Secret-Key" = "synthetic-secret" }'));
  const result = await loadSellerSpriteConfig({ configPath, env: { SCOUT_SELLERSPRITE_CONFIG_PATH: path.join(directory, "missing.toml") } });
  assert.equal(result.configPath, configPath);
  assert.deepEqual(result.headers, { "secret-key": "synthetic-secret" });
});

test("all four legacy section aliases can be copied into the standalone file", async () => {
  for (const name of ["sellsprite-mcp", "sellersprite-mcp", "sellsprite", "sellersprite"]) {
    const configPath = await fixture(section(`mcp_servers.${name}`));
    const result = await loadSellerSpriteConfig({ configPath, env: { TEST_SECRET: "synthetic-secret" } });
    assert.equal(result.name, name);
    assert.equal(result.headers["secret-key"], "synthetic-secret");
  }
});

test("standalone and legacy sections cannot silently select between two credentials", async () => {
  for (const source of [section() + section("mcp_servers.sellersprite"),
    section() + section("mcp_servers.sellsprite") + "enabled = false\n"]) {
    const configPath = await fixture(source);
    await assert.rejects(loadSellerSpriteConfig({ configPath, env: { TEST_SECRET: "synthetic-secret" } }), {
      code: "SELLSPRITE_CONFIG_INVALID", message: "Multiple SellerSprite MCP configurations are ambiguous.",
    });
  }
});

test("bearer authentication uses only the caller's supplied environment", async () => {
  const configPath = await fixture(section("sellersprite", 'bearer_token_env_var = "TEST_BEARER"'));
  const config = await loadSellerSpriteConfig({ configPath, env: { TEST_BEARER: "synthetic-secret" } });
  assert.deepEqual(config.headers, { authorization: "Bearer synthetic-secret" });
  await assert.rejects(loadSellerSpriteConfig({ configPath, env: {} }), assertPrivateConfigError);
});

test("disabled, absent, malformed, and insecure settings report only redacted diagnostics", async () => {
  const sources = [
    section() + "enabled = false\n",
    "[unrelated]\nurl = 'https://mcp.example.test/mcp'\n",
    "[broken\nsecret-key='synthetic-secret'",
    section().replace("https:", "http:"),
    section().replace("mcp.example.test", "user:synthetic-secret@mcp.example.test"),
    section().replace("https://mcp.example.test/mcp", "invalid-synthetic-secret"),
    section("sellersprite", 'http_headers = { "secret-key" = " " }'),
    section("sellersprite", 'http_headers = { "secret-key" = 42 }'),
    section("sellersprite", 'http_headers = "synthetic-secret"'),
    section("sellersprite", 'env_http_headers = ["TEST_SECRET"]'),
    section("sellersprite", 'http_headers = { "secret-key" = "synthetic-secret\\r\\nX-Test: injected" }'),
    section("sellersprite", 'http_headers = { "Accept" = "application/json" }'),
  ];
  for (const source of sources) {
    await assert.rejects(loadSellerSpriteConfig({ configPath: await fixture(source), env: { TEST_SECRET: "synthetic-secret" } }),
      assertPrivateConfigError);
  }
});

test("missing authentication environment values do not fall back to other configuration", async () => {
  const configPath = await fixture(section());
  for (const env of [{}, { TEST_SECRET: " " }, { TEST_SECRET: 123 }]) {
    await assert.rejects(loadSellerSpriteConfig({ configPath, env }), assertPrivateConfigError);
  }
});

test("configuration example is runnable with an injected key and leaves the key out of the file", async () => {
  const configPath = path.join(projectRoot, "config", "sellersprite.example.toml");
  const before = await readFile(configPath, "utf8");
  const result = await loadSellerSpriteConfig({ configPath, env: { SCOUT_SELLERSPRITE_SECRET_KEY: "synthetic-secret" } });
  assert.equal(result.endpoint.href, "https://mcp.sellersprite.com/mcp");
  assert.equal(result.headers["secret-key"], "synthetic-secret");
  assert.doesNotMatch(before, /synthetic-secret/);
  assert.equal(await readFile(configPath, "utf8"), before);
});
