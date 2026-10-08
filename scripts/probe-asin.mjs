import { callSellerSpriteTool, resetSellerSpriteClient } from "../lib/sellsprite-client.mjs";

const asin = process.argv[2] || "B0FCBWSBTG";
const tools = ["asin_detail"];

function parseTextResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block?.text) return null;
  return JSON.parse(block.text);
}

function describe(value, depth = 0) {
  if (depth >= 5) return Array.isArray(value) ? `[array:${value.length}]` : typeof value;
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, first: value.length ? describe(value[0], depth + 1) : null };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, describe(item, depth + 1)]));
  }
  if (typeof value === "string") return value.length > 100 ? `${value.slice(0, 100)}...` : value;
  return value;
}

try {
  for (const name of tools) {
    const result = await callSellerSpriteTool(name, { marketplace: "AU", asin });
    const payload = parseTextResult(result);
    process.stdout.write(`${JSON.stringify({ tool: name, isError: result.isError || false, shape: describe(payload) }, null, 2)}\n`);
  }
} finally {
  await resetSellerSpriteClient();
}
