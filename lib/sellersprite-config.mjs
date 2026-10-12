import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVER_NAMES = ["sellsprite-mcp", "sellersprite-mcp", "sellsprite", "sellersprite"];

function configError(message) {
  const error = new Error(message);
  error.name = "SellerSpriteConfigError";
  error.code = "SELLSPRITE_CONFIG_INVALID";
  return error;
}

function resolveConfigPath(configPath) {
  if (typeof configPath !== "string" || !configPath.trim()) {
    throw configError("The SellerSprite configuration path is invalid.");
  }
  return path.resolve(PROJECT_ROOT, configPath);
}

// Resolve relative paths against this installation, even when a launcher changes cwd.
export function getSellerSpriteConfigPath({ env = process.env } = {}) {
  return resolveConfigPath(env.SCOUT_SELLERSPRITE_CONFIG_PATH || "config/sellersprite.local.toml");
}

function isTable(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authenticationVariable(env, variable) {
  if (typeof variable !== "string" || !variable.trim()
    || typeof env[variable] !== "string" || !env[variable].trim()) {
    throw configError("A SellerSprite authentication environment variable is missing.");
  }
  return env[variable];
}

export async function loadSellerSpriteConfig({ configPath, env = process.env } = {}) {
  configPath = configPath === undefined ? getSellerSpriteConfigPath({ env }) : resolveConfigPath(configPath);
  let config;
  try {
    config = parse(await readFile(configPath, "utf8"));
  } catch {
    // TOML diagnostics can include source lines and credentials; never forward them.
    throw configError("The SellerSprite MCP configuration file is missing, unreadable, or invalid.");
  }
  const configured = [];
  if (Object.hasOwn(config, "sellersprite")) configured.push({ name: "sellersprite", server: config.sellersprite });
  for (const name of SERVER_NAMES) {
    if (isTable(config.mcp_servers) && Object.hasOwn(config.mcp_servers, name)) {
      configured.push({ name, server: config.mcp_servers[name] });
    }
  }
  if (configured.length !== 1) {
    throw configError(configured.length ? "Multiple SellerSprite MCP configurations are ambiguous."
      : "The configuration does not contain a recognized SellerSprite MCP server.");
  }
  const { name, server } = configured[0];
  if (!isTable(server)) throw configError("The SellerSprite MCP configuration must be a table.");
  if (server.enabled === false) throw configError("The SellerSprite MCP configuration is disabled.");
  if (typeof server.url !== "string") throw configError("The SellerSprite MCP configuration does not define a URL.");
  let endpoint;
  try { endpoint = new URL(server.url); } catch { throw configError("The SellerSprite MCP URL is invalid."); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw configError("The SellerSprite MCP endpoint must use HTTPS without URL credentials.");
  }

  const headers = new Headers();
  try {
    for (const field of ["http_headers", "env_http_headers"]) {
      if (server[field] !== undefined && !isTable(server[field])) throw configError("Invalid authentication headers.");
    }
    for (const [key, value] of Object.entries(server.http_headers || {})) {
      if (typeof value !== "string" || !value.trim()) throw configError("Invalid authentication header value.");
      headers.set(key, value);
    }
    for (const [key, variable] of Object.entries(server.env_http_headers || {})) {
      headers.set(key, authenticationVariable(env, variable));
    }
    if (server.bearer_token_env_var !== undefined) {
      headers.set("Authorization", `Bearer ${authenticationVariable(env, server.bearer_token_env_var)}`);
    }
  } catch {
    throw configError("SellerSprite authentication headers or environment variables are missing or invalid.");
  }
  if (!headers.has("secret-key") && !headers.has("authorization")) {
    throw configError("The SellerSprite MCP configuration does not define an authentication header.");
  }
  return { name, endpoint, headers: Object.fromEntries(headers.entries()), configPath };
}
