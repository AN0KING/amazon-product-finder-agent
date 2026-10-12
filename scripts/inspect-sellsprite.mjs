import { listSellerSpriteTools, resetSellerSpriteClient, classifySellerSpriteConnectionError } from "../lib/sellsprite-client.mjs";

const selectedNames = new Set(["asin_detail", "competitor_lookup"]);

try {
  const tools = await listSellerSpriteTools({ refresh: true });
  const selected = tools
    .filter((tool) => selectedNames.has(tool.name))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  process.stdout.write(`${JSON.stringify({ connected: true, toolCount: tools.length, tools: selected }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ connected: false, error: classifySellerSpriteConnectionError(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await resetSellerSpriteClient();
}
