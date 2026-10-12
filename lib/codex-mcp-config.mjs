// Compatibility for previous imports only. Runtime configuration is independent of Codex.
export { loadSellerSpriteConfig, getSellerSpriteConfigPath } from "./sellersprite-config.mjs";
// Deprecated name; resolves to Scout's standalone configuration, never an AI application's home.
export { getSellerSpriteConfigPath as getCodexConfigPath } from "./sellersprite-config.mjs";
