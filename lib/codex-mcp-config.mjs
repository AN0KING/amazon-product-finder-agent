import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

const SERVER_NAME = "sellsprite-mcp";

export function getCodexConfigPath() {
  const userHome = process.env.USERPROFILE || os.homedir();
  return process.env.SCOUT_CODEX_CONFIG_PATH || path.join(userHome, ".codex", "config.toml");
}

export async function loadSellerSpriteConfig() {
  const configPath = getCodexConfigPath();
  const source = await readFile(configPath, "utf8");
  const config = parse(source);
  const server = config.mcp_servers?.[SERVER_NAME];

  if (!server) throw new Error(`Codex config does not contain ${SERVER_NAME}.`);
  if (server.enabled === false) throw new Error(`${SERVER_NAME} is disabled in Codex config.`);
  if (typeof server.url !== "string") throw new Error(`${SERVER_NAME} does not define a URL.`);

  const endpoint = new URL(server.url);
  if (endpoint.protocol !== "https:") throw new Error(`${SERVER_NAME} must use HTTPS.`);

  const headers = Object.fromEntries(
    Object.entries(server.http_headers || {}).filter(([, value]) => typeof value === "string" && value.length > 0),
  );
  if (!Object.keys(headers).length) throw new Error(`${SERVER_NAME} does not define authentication headers.`);

  return {
    name: SERVER_NAME,
    endpoint,
    headers,
    configPath,
  };
}
